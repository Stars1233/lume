import { posix } from "../deps/path.ts";
import { normalizePath } from "./utils/path.ts";
import { mergeData } from "./utils/merge_data.ts";
import { getPageUrl } from "./utils/page_url.ts";
import { getPageDate } from "./utils/page_date.ts";
import { Page, StaticFile } from "./file.ts";

import type { Data, RawData } from "./file.ts";
import type { default as FS, Entry } from "./fs.ts";
import type { default as Formats, Format } from "./formats.ts";
import type DataLoader from "./data_loader.ts";
import type { ScopeFilter } from "./scopes.ts";
import type {
  Components,
  default as ComponentLoader,
} from "./component_loader.ts";

export interface Options {
  formats: Formats;
  dataLoader: DataLoader;
  componentLoader: ComponentLoader;
  scopedData: Map<string, RawData>;
  scopedPages: Map<string, RawData[]>;
  scopedComponents: Map<string, Components>;
  basenameParsers: BasenameParser[];
  fs: FS;
  prettyUrls: boolean;
  components: {
    variable: string;
    cssFile: string;
    jsFile: string;
  };
}

/**
 * Scan and load files from the source folder
 * with the data, pages, assets and static files
 */
export default class Source {
  /** Filesystem reader to scan folders */
  fs: FS;

  /** To load all _data files */
  dataLoader: DataLoader;

  /** To load all components */
  componentLoader: ComponentLoader;

  /** Info about how to handle different file formats */
  formats: Formats;

  /** The list of paths to ignore */
  ignored = new Set<string>();

  /** The path filters to ignore */
  filters: ScopeFilter[] = [];

  /** The data assigned per path */
  scopedData: Map<string, RawData>;

  /** The pages assigned per path */
  scopedPages: Map<string, RawData[]>;

  /** The components assigned per path */
  scopedComponents: Map<string, Components>;

  /** Use pretty URLs */
  prettyUrls: boolean;

  /** List of static files and folders to copy */
  staticPaths = new Map<
    string,
    { dest: string | ((path: string) => string) | undefined; dirOnly: boolean }
  >();

  /** Extra code generated by the components */
  extraCode = new Map<string, Map<string, string>>();

  components: {
    /** File name used to output the extra CSS code generated by the components */
    cssFile: string;

    /** File name used to output the extra JavaScript code generated by the components */
    jsFile: string;

    /** Variable name used to access to the components */
    variable: string;
  };

  /** The data assigned per path */
  data = new Map<string, Partial<Data>>();

  /** Custom parsers for basenames */
  basenameParsers: BasenameParser[] = [];

  constructor(options: Options) {
    this.dataLoader = options.dataLoader;
    this.componentLoader = options.componentLoader;
    this.fs = options.fs;
    this.formats = options.formats;
    this.components = options.components;
    this.scopedData = options.scopedData;
    this.scopedPages = options.scopedPages;
    this.scopedComponents = options.scopedComponents;
    this.prettyUrls = options.prettyUrls;
    this.basenameParsers = options.basenameParsers;
  }

  addIgnoredPath(path: string) {
    this.ignored.add(normalizePath(path));
  }

  addIgnoreFilter(filter: ScopeFilter) {
    this.filters.push(filter);
  }

  addStaticPath(from: string, to?: string | ((path: string) => string)) {
    if (from.startsWith("../")) {
      throw new Error(
        `It's not possible to copy files outsite the src directory ("${from}")`,
      );
    }

    this.staticPaths.set(
      normalizePath(from.replace(/\/$/, "")),
      {
        dest: typeof to === "string" ? normalizePath(to) : to,
        dirOnly: from.endsWith("/"),
      },
    );
  }

  async build(...buildFilters: BuildFilter[]): Promise<[Page[], StaticFile[]]> {
    const pages: Page[] = [];
    const staticFiles: StaticFile[] = [];

    await this.#load(
      buildFilters,
      this.fs.entries.get("/")!,
      "/",
      new Map(),
      {},
      pages,
      staticFiles,
    );

    return [
      pages,
      staticFiles,
    ];
  }

  async #load(
    buildFilters: BuildFilter[],
    dir: Entry,
    parentPath: string,
    parentComponents: Components,
    parentData: RawData,
    pages: Page[],
    staticFiles: StaticFile[],
    copy?: (path: string) => string,
  ): Promise<void> {
    if (buildFilters.some((filter) => !filter(dir))) {
      return;
    }

    // Load _data
    const dirData = await this.#loadDirData(dir, parentData);
    let dirPath = posix.join(parentPath, dirData.basename!);

    // Load _components
    const dirComponents = await this.#loadDirComponents(
      dir,
      parentComponents,
      dirData,
    );

    // Create the components proxy only if new components were found
    if (dirComponents !== parentComponents) {
      dirData[this.components.variable] = toProxy(
        dirComponents,
        this.extraCode,
      );
    }

    // Store the root data to be used by other plugins
    this.data.set(dirPath, dirData);

    // Load pages created with `site.page()`
    for await (const page of this.#getDirPages(dirPath, dirData)) {
      if (buildFilters.some((filter) => !filter(dir, page))) {
        continue;
      }
      pages.push(page);
    }

    // The folder is copied with `site.copy("folder")`
    const copyExplicit = this.staticPaths.get(dir.path) ||
      this.staticPaths.get(dirPath);

    if (copyExplicit) {
      const { dest } = copyExplicit;

      if (typeof dest === "function") {
        const previousCopy = copy;
        copy = previousCopy ? (path: string) => dest(previousCopy(path)) : dest;
      } else {
        dirPath = dest ?? dirPath;
        copy ??= (path: string) => path;
      }
    }

    // Iterate over the directory entries
    for (const entry of dir.children.values()) {
      if (buildFilters.some((filter) => !filter(entry))) {
        continue;
      }

      if (entry.type === "file") {
        let copyExplicit = this.staticPaths.get(entry.path);

        if (copyExplicit?.dirOnly) {
          // the explicit copy must be a directory and this is a file
          copyExplicit = undefined;
        }

        // Check if the file must be ignored
        if (!copyExplicit && this.#isIgnored(entry)) {
          continue;
        }

        const format = this.formats.search(entry.path);

        // It's an unknown file format
        if (!format) {
          // Copy the file
          if (copyExplicit || copy) {
            const ext = posix.extname(entry.name);
            staticFiles.push(
              this.#copyFile(entry, dirPath, ext, copyExplicit?.dest, copy),
            );
          }
          continue;
        }

        // The format is a page `site.loadPages([".ext"])` or `site.loadAssets([".ext"])`
        if (format.pageType) {
          const page = await this.#loadPage(entry, format, dirData, dirPath);

          if (
            page &&
            (!buildFilters.length ||
              buildFilters.every((filter) => filter(entry, page)))
          ) {
            pages.push(page);
          }

          continue;
        }

        // The format is copied with `site.copy([".ext"])`
        if (format.copy) {
          staticFiles.push(
            this.#copyFile(
              entry,
              dirPath,
              format.ext,
              typeof format.copy === "function" ? format.copy : undefined,
            ),
          );
          continue;
        }

        // Ignore the file
        continue;
      }

      if (entry.type === "directory") {
        // Check if the folder must be ignored
        if (
          !copyExplicit &&
          this.#isIgnored(entry) &&
          entry.path !== "/.well-known"
        ) {
          // Check if there's an inner entry that must be copied
          for (const path of this.staticPaths.keys()) {
            if (path.startsWith(entry.path)) {
              this.#searchStaticFiles(
                buildFilters,
                entry,
                dirPath,
                staticFiles,
              );
              break;
            }
          }
          continue;
        }

        await this.#load(
          buildFilters,
          entry,
          dirPath,
          dirComponents,
          dirData,
          pages,
          staticFiles,
          copy,
        );
      }
    }
  }

  #isIgnored(entry: Entry) {
    return entry.name.startsWith(".") ||
      entry.name.startsWith("_") ||
      this.ignored.has(entry.path) ||
      this.filters.some((filter) => filter(entry.path));
  }

  #searchStaticFiles(
    buildFilters: BuildFilter[],
    dir: Entry,
    parentPath: string,
    staticFiles: StaticFile[],
    copy?: (path: string) => string,
  ): void {
    if (buildFilters.some((filter) => !filter(dir))) {
      return;
    }

    let dirPath = posix.join(parentPath, dir.name);

    // The folder is copied with `site.copy("folder")`
    const copyExplicit = this.staticPaths.get(dir.path);

    if (copyExplicit) {
      const { dest } = copyExplicit;

      if (typeof dest === "function") {
        const previousCopy = copy;
        copy = previousCopy ? (path: string) => dest(previousCopy(path)) : dest;
      } else {
        dirPath = dest ?? dirPath;
        copy ??= (path: string) => path;
      }
    }

    // Iterate over the directory entries
    for (const entry of dir.children.values()) {
      if (buildFilters.some((filter) => !filter(entry))) {
        continue;
      }

      if (entry.type === "file") {
        let copyExplicit = this.staticPaths.get(entry.path);

        if (copyExplicit?.dirOnly) {
          // the explicit copy must be a directory and this is a file
          copyExplicit = undefined;
        }

        // Check if the file must be ignored
        if (!copyExplicit && this.#isIgnored(entry)) {
          continue;
        }

        // Copy the file
        if (copyExplicit || copy) {
          const ext = posix.extname(entry.name);
          staticFiles.push(
            this.#copyFile(entry, dirPath, ext, copyExplicit?.dest, copy),
          );
        }
        continue;
      }

      if (entry.type === "directory") {
        // Check if a inner entry must be copied
        for (const path of this.staticPaths.keys()) {
          if (path.startsWith(entry.path)) {
            this.#searchStaticFiles(
              buildFilters,
              entry,
              dirPath,
              staticFiles,
              copy,
            );
            break;
          }
        }
      }
    }
  }

  /** Load a folder's _data and merge it with the parent data  */
  async #loadDirData(dir: Entry, parentData: RawData): Promise<Partial<Data>> {
    // Parse the directory's basename
    const { basename, ...parsedData } = runBasenameParsers(
      dir.name,
      this.basenameParsers,
    );

    // Load _data files
    const dirDatas: RawData[] = [];

    for (const entry of dir.children.values()) {
      if (
        (entry.type === "file" && entry.name.startsWith("_data.")) ||
        (entry.type === "directory" && entry.name === "_data")
      ) {
        const loaded = await this.dataLoader.load(entry);
        if (loaded) {
          dirDatas.push(loaded);
        }
      }
    }

    // Data registered from site.data()
    const scopedData = this.scopedData.get(dir.path) || {};

    // Merge directory data
    return mergeData(
      parentData,
      { basename },
      scopedData,
      parsedData,
      ...dirDatas,
    ) as Partial<Data>;
  }

  /**
   * Load _components, merge them with the parent components
   * and store on the data object
   */
  async #loadDirComponents(
    dir: Entry,
    parentComponents: Components,
    data: Partial<Data>,
  ): Promise<Components> {
    // Components registered from site.component()
    const scopedComponents = this.scopedComponents.get(dir.path);
    let loadedComponents: Components | undefined;

    // Load _components files
    for (const entry of dir.children.values()) {
      if (entry.type === "directory" && entry.name === "_components") {
        loadedComponents = await this.componentLoader.load(entry, data);
        break;
      }
    }

    // Merge the components
    if (scopedComponents || loadedComponents) {
      parentComponents = mergeComponents(
        parentComponents,
        scopedComponents || new Map(),
        loadedComponents || new Map(),
      );
    }

    return parentComponents;
  }

  async *#getDirPages(
    path: string,
    dirData: Partial<Data>,
  ): AsyncGenerator<Page> {
    const pages = this.scopedPages.get(path);
    if (!pages) {
      return;
    }

    for (const data of pages) {
      const basename = posix.basename(data.url as string).replace(
        /\.[\w.]+$/,
        "",
      );
      const page = new Page();
      page.data = mergeData(
        dirData,
        { basename, date: new Date() },
        data,
      ) as Data;

      const url = getPageUrl(page, this.prettyUrls, path);
      if (!url) {
        continue;
      }
      page.data.url = url;
      page.data.date = getPageDate(page);
      page.data.page = page;
      yield page;
    }
  }

  /** Load a page from a file entry */
  async #loadPage(
    entry: Entry,
    format: Format,
    dirData: Partial<Data>,
    dirPath: string,
  ): Promise<Page | undefined> {
    const loader = format.pageType === "asset"
      ? format.assetLoader
      : format.loader;

    if (!loader) {
      throw new Error(
        `Missing loader for ${format.pageType} page type (${entry.path}))`,
      );
    }

    const { ext } = format;
    const { basename, ...parsedData } = runBasenameParsers(
      entry.name.slice(0, -ext.length),
      this.basenameParsers,
    );

    // Create the page
    const page = new Page({
      path: entry.path.slice(0, -ext.length),
      ext,
      entry,
    });
    page.asset = format.pageType === "asset";

    // Load and merge the page data
    const pageData = await entry.getContent(loader);
    page.data = mergeData(
      dirData,
      { basename },
      this.scopedData.get(entry.path) || {},
      parsedData,
      pageData,
    ) as Data;

    // Calculate the page URL
    const url = getPageUrl(page, this.prettyUrls, dirPath);
    if (!url) {
      return;
    }
    page.data.url = url;

    // Calculate the page date
    page.data.date = getPageDate(page);

    // Save the page object in the data object
    page.data.page = page;

    // Save whether the layout was directly assigned
    page._data.layout = pageData.layout;

    return page;
  }

  #copyFile(
    entry: Entry,
    dirPath: string,
    ext: string,
    dest?: string | ((path: string) => string),
    copy?: (path: string) => string,
  ): StaticFile {
    return new StaticFile(
      getOutputPath(
        entry,
        dirPath,
        dest,
        copy,
      ),
      {
        ext,
        path: entry.path.slice(1, -ext.length),
        entry,
      },
    );
  }

  /** Returns the pages with extra code generated by the components */
  getComponentsExtraCode(): [string, string][] {
    const files = {
      css: this.components.cssFile,
      js: this.components.jsFile,
    };

    const pages: [string, string][] = [];

    for (const [type, path] of Object.entries(files)) {
      const code = this.extraCode.get(type);

      if (code && code.size) {
        pages.push([
          path,
          Array.from(code.values()).join("\n"),
        ]);
      }
    }

    return pages;
  }
}

/**
 * Create and returns a proxy to use the components
 * as comp.name() instead of components.get("name").render()
 */
function toProxy(
  components: Components,
  extraCode?: Map<string, Map<string, string>>,
): ProxyComponents {
  const node = {
    _components: components,
    _proxies: new Map(),
  };
  return new Proxy(node, {
    get: (target, name) => {
      if (typeof name !== "string" || name in target) {
        return;
      }

      const key = name.toLowerCase();

      if (target._proxies.has(key)) {
        return target._proxies.get(key);
      }

      const component = target._components.get(key);

      if (!component) {
        throw new Error(`Component "${name}" not found`);
      }

      if (component instanceof Map) {
        const proxy = toProxy(component, extraCode);
        target._proxies.set(key, proxy);
        return proxy;
      }

      // Save CSS & JS code for the component
      if (extraCode) {
        if (component.css) {
          const code = extraCode.get("css") ?? new Map();
          code.set(key, component.css);
          extraCode.set("css", code);
        }

        if (component.js) {
          const code = extraCode.get("js") ?? new Map();
          code.set(key, component.js);
          extraCode.set("js", code);
        }
      }

      // Return the function to render the component
      return (props: Record<string, unknown>) => component.render(props);
    },
  }) as unknown as ProxyComponents;
}

export type BuildFilter = (entry: Entry, page?: Page) => boolean;

export type BasenameParser = (filename: string) => RawData | undefined;

export interface ProxyComponents {
  // deno-lint-ignore no-explicit-any
  (props?: Record<string, unknown>): any;
  [key: string]: ProxyComponents;
}

/** Merge the cascade components */
function mergeComponents(...components: Components[]): Components {
  return components.reduce((previous, current) => {
    const components = new Map(previous);

    for (const [key, value] of current) {
      if (components.has(key)) {
        const previousValue = components.get(key);

        if (previousValue instanceof Map && value instanceof Map) {
          components.set(key, mergeComponents(value, previousValue));
        } else {
          components.set(key, value);
        }
      } else {
        components.set(key, value);
      }
    }
    return components;
  });
}

function getOutputPath(
  entry: Entry,
  path: string,
  dest?: string | ((path: string) => string),
  copy?: (path: string) => string,
): string {
  if (typeof dest === "string") {
    return dest;
  }

  let output = posix.join(path, entry.name);

  if (copy) {
    output = copy(output);
  }

  return typeof dest === "function" ? dest(output) : output;
}

function runBasenameParsers(
  basename: string,
  basenameParsers: BasenameParser[],
): RawData {
  const data: RawData = { basename };

  for (const parser of basenameParsers) {
    const res = parser(basename);
    if (res === undefined) {
      continue;
    }
    res.basename ??= basename;
    Object.assign(data, res);
    if (res.basename === "") {
      break;
    }
  }

  return data;
}
