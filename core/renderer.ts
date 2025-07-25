import { resolveInclude } from "./utils/path.ts";
import { isGenerator } from "./utils/generator.ts";
import { concurrent } from "./utils/concurrent.ts";
import { mergeData } from "./utils/merge_data.ts";
import { getBasename, getPageUrl } from "./utils/page_url.ts";
import { getPageDate } from "./utils/page_date.ts";
import { Page } from "./file.ts";
import { posix } from "../deps/path.ts";

import type { Content, Data, RawData } from "./file.ts";
import type Processors from "./processors.ts";
import type Formats from "./formats.ts";
import type FS from "./fs.ts";
import type DebugBar from "./debugbar.ts";

export interface Options {
  includes: string;
  prettyUrls: boolean;
  preprocessors: Processors;
  formats: Formats;
  fs: FS;
}

/**
 * The renderer is responsible for rendering the site pages
 * in the right order and using the right template engine.
 */
export default class Renderer {
  /** The default folder to include the layouts */
  includes: string;

  /** The filesystem instance used to read the layouts */
  fs: FS;

  /** To convert the urls to pretty /example.html => /example/ */
  prettyUrls: boolean;

  /** All preprocessors */
  preprocessors: Processors;

  /** Available file formats */
  formats: Formats;

  /** The registered helpers */
  helpers = new Map<string, [Helper, HelperOptions]>();

  constructor(options: Options) {
    this.includes = options.includes;
    this.prettyUrls = options.prettyUrls;
    this.preprocessors = options.preprocessors;
    this.formats = options.formats;
    this.fs = options.fs;
  }

  /** Register a new helper used by the template engines */
  addHelper(name: string, fn: Helper, options: HelperOptions) {
    this.helpers.set(name, [fn, options]);

    for (const format of this.formats.entries.values()) {
      format.engines?.forEach((engine) => engine.addHelper(name, fn, options));
    }

    return this;
  }

  /** Render the provided pages */
  async renderPages(
    from: Page[],
    to: Page[],
    debugBar?: DebugBar,
  ): Promise<void> {
    const renderedPages: Page[] = [];

    for (const group of this.#groupPages(from)) {
      const pages: Page[] = [];
      const generators: Page[] = [];

      // Split regular pages and generators
      for (const page of group) {
        if (isGenerator(page.data.content)) {
          generators.push(page);
          continue;
        }

        pages.push(page);
      }

      // Preprocess the pages and add them to site.pages
      await this.preprocessors.run(pages, debugBar);
      to.push(...pages);

      debugBar?.startMeasure("generators");
      const generatedPages: Page[] = [];
      for (const page of generators) {
        const data = { ...page.data };
        const { content } = data;
        delete data.content;

        const generator = await this.render<Generator<RawData, RawData>>(
          content,
          data,
          page.src.path + page.src.ext,
        );

        let index = 0;
        const basePath = posix.dirname(page.data.url);

        for await (const data of generator) {
          if (!data.content) {
            data.content = undefined;
          }
          const newPage = page.duplicate(
            index++,
            mergeData(page.data, data) as Data,
          );

          let base = basePath;

          if (data.url === false) {
            continue;
          }

          if (!data.url && data.basename !== undefined) {
            // @ts-ignore: The url is added later
            delete newPage.data.url;
            base = posix.dirname(page.outputPath);
          }

          const url = getPageUrl(newPage, this.prettyUrls, base);

          if (!url) {
            continue;
          }

          newPage.data.url = url;
          newPage.data.basename = getBasename(url);
          newPage.data.date = getPageDate(newPage);

          // Prevent running the layout if the page is not HTML
          if (!data.layout && !newPage.outputPath.endsWith(".html")) {
            delete newPage.data.layout;
          }
          generatedPages.push(newPage);
        }
      }
      debugBar?.endMeasure(
        "generators",
        `[Generators] Created ${generatedPages.length} pages`,
      );

      // Preprocess the generators and add them to site.pages
      await this.preprocessors.run(generatedPages, debugBar);
      to.push(...generatedPages);

      // Render the pages content
      debugBar?.startMeasure("render");
      await concurrent(
        pages.concat(generatedPages),
        async (page) => {
          try {
            const content = await this.#renderPage(page);

            // Save the children to render the layout later
            if (page.data.layout || page.outputPath.endsWith(".html")) {
              page.data.children = content;
              renderedPages.push(page);
            } else {
              page.content = content;
            }
          } catch (cause) {
            throw new Error(`Error rendering the page: ${page.sourcePath}`, {
              cause,
            });
          }
        },
      );
      debugBar?.endMeasure(
        "render",
        `[Rendering] Content of ${renderedPages.length} pages`,
      );
    }

    // Render the pages layouts at the end
    debugBar?.startMeasure("render-layouts");
    await concurrent(
      renderedPages,
      async (page) => {
        try {
          page.content = await this.#renderLayout(
            page,
            page.data.children as Content,
          );
        } catch (cause) {
          throw new Error(
            `Error rendering the layout of the page ${page.sourcePath}`,
            { cause },
          );
        }
      },
    );
    debugBar?.endMeasure(
      "render-layouts",
      `[Rendering] Layouts of ${renderedPages.length} pages`,
    );
  }

  /** Render a template */
  async render<T>(
    content: unknown,
    data: Record<string, unknown>,
    filename: string,
    isLayout = false,
  ): Promise<T> {
    const engines = this.#getEngine(filename, data, isLayout);

    if (engines) {
      for (const engine of engines) {
        content = await engine.render(content, data, filename);
      }
    }

    return content as T;
  }

  /** Group the pages by renderOrder */
  #groupPages(pages: Page[]): Page[][] {
    const renderOrder: Record<number | string, Page[]> = {};

    for (const page of pages) {
      const order = page.data.renderOrder || 0;
      renderOrder[order] = renderOrder[order] || [];
      renderOrder[order].push(page);
    }

    return Object.keys(renderOrder).sort().map((order) => renderOrder[order]);
  }

  /** Render a page */
  async #renderPage(page: Page): Promise<Content> {
    const data = { ...page.data };
    const { content } = data;
    delete data.content;

    return await this.render<Content>(
      content,
      data,
      page.src.path + page.src.ext,
    );
  }

  /** Render the page layout */
  async #renderLayout(page: Page, content: Content): Promise<Content> {
    let data = { ...page.data };
    let path = page.src.path + page.src.ext;
    let layout = data.layout;

    // Render the layouts recursively
    while (layout) {
      const format = this.formats.search(layout);

      if (!format || !format.loader) {
        throw new Error(`The layout format "${layout}" doesn't exist`);
      }

      const includesPath = format.engines?.[0].includes;

      if (!includesPath) {
        throw new Error(
          `The layout format "${layout}" doesn't support includes`,
        );
      }

      const layoutPath = resolveInclude(
        layout,
        includesPath,
        posix.dirname(path),
      );
      const entry = this.fs.entries.get(layoutPath);

      if (!entry) {
        throw new Error(`The layout file "${layoutPath}" doesn't exist`);
      }

      const layoutData = await entry.getContent(format.loader);

      delete data.layout;
      delete data.templateEngine;

      data = mergeData(
        layoutData,
        data,
        { content },
      ) as Data;

      content = await this.render<Content>(
        layoutData.content,
        data,
        layoutPath,
        true,
      );
      layout = layoutData.layout;
      path = layoutPath;
    }

    return content;
  }

  /** Get the engines assigned to an extension or configured in the data */
  #getEngine(
    path: string,
    data: Partial<Data>,
    isLayout: boolean,
  ): Engine[] | undefined {
    let { templateEngine } = data;

    if (templateEngine) {
      templateEngine = Array.isArray(templateEngine)
        ? templateEngine
        : templateEngine.split(",");

      return templateEngine.reduce((engines, name) => {
        const format = this.formats.get(`.${name.trim()}`);

        if (format?.engines) {
          return engines.concat(format.engines);
        }

        throw new Error(`The template engine "${name}" doesn't exist`);
      }, [] as Engine[]);
    }

    const format = this.formats.search(path);

    if (isLayout || format?.isPage) {
      return format?.engines;
    }
  }
}

/** An interface used by all template engines */
export interface Engine<T = string | { toString(): string }> {
  /** The folder name of the includes */
  includes?: string;

  /** Delete a cached template */
  deleteCache(file: string): void;

  /** Render a template (used to render pages) */
  render(
    content: unknown,
    data?: Record<string, unknown>,
    filename?: string,
  ): T | Promise<T>;

  /** Add a helper to the template engine */
  addHelper(
    name: string,
    fn: Helper,
    options: HelperOptions,
  ): void;
}

/** A generic helper to be used in template engines */
export interface HelperThis {
  data?: Data;
}

// deno-lint-ignore no-explicit-any
export type Helper = (this: HelperThis | void, ...args: any[]) => any;

/** The options for a template helper */
export interface HelperOptions {
  /** The type of the helper (tag, filter, etc) */
  type: string;

  /** Whether the helper returns an instance or not */
  async?: boolean;

  /** Whether the helper has a body or not (used for tag types) */
  body?: boolean;
}
