import { minify } from "../deps/terser.ts";
import { merge } from "../core/utils/object.ts";
import { Page } from "../core/file.ts";
import { prepareAsset, saveAsset } from "./source_maps.ts";
import { log, warnUntil } from "../core/utils/log.ts";
import { concurrent } from "../core/utils/concurrent.ts";
import { bytes, percentage } from "../core/utils/format.ts";

import type Site from "../core/site.ts";
import type { MinifyOptions } from "../deps/terser.ts";
import type { Item } from "../deps/debugbar.ts";

export interface Options {
  /** File extensions to minify */
  extensions?: string[];

  /**
   * Options passed to `terser`
   * @see https://terser.org/docs/api-reference/#minify-options
   */
  options?: MinifyOptions;
}

// Default options
export const defaults: Options = {
  extensions: [".js"],
  options: {
    module: true,
    compress: true,
    mangle: true,
  },
};

/**
 * A plugin to minify them using Terser
 * @see https://lume.land/plugins/terser/
 */
export function terser(userOptions?: Options) {
  const options = merge(defaults, userOptions);

  return (site: Site) => {
    site.filter("terser", filter, true);
    site.process(options.extensions, function processTerser(files: Page[]) {
      const hasPages = warnUntil(
        "[terser plugin] No files found. Make sure to add the JS files with <code>site.add()</code>",
        files.length,
      );

      if (!hasPages) {
        return;
      }

      const item = site.debugBar?.buildItem(
        "[terser plugin] minification completed",
      );

      return concurrent(files, (file) => terser(file, item));
    });

    async function terser(page: Page, item?: Item) {
      const { content, filename, sourceMap, enableSourceMap } = prepareAsset(
        site,
        page,
      );

      const terserOptions = {
        ...options.options,
        sourceMap: enableSourceMap
          ? {
            content: JSON.stringify(sourceMap),
            filename: filename,
          }
          : undefined,
      };

      try {
        const output = await minify({ [filename]: content }, terserOptions);

        if (item && output.code) {
          item.items ??= [];
          const old = content.length;
          const minified = output.code.length;

          item.items.push({
            title: `[${percentage(old, minified)}] ${page.data.url}`,
            details: `${bytes(page.bytes.length)}`,
          });
        }
        saveAsset(
          site,
          page,
          output.code!,
          // @ts-expect-error: terser uses @jridgewell/gen-mapping, which incorrectly has typed some types as nullable: https://github.com/jridgewell/gen-mapping/pull/9
          output.map,
        );
      } catch (cause) {
        log.error(
          `[terser plugin] Error processing the file: ${filename} by the Terser plugin. (${cause})`,
        );
      }
    }

    async function filter(code: string): Promise<string | undefined> {
      const output = await minify(code, options.options);
      return output.code;
    }
  };
}

export default terser;

/** Extends Helpers interface */
declare global {
  namespace Lume {
    export interface Helpers {
      /** @see https://lume.land/plugins/terser/#the-terser-filter */
      terser: (code: string) => Promise<string | undefined>;
    }
  }
}
