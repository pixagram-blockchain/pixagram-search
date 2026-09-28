// Wrangler turns `import x from "./file.wasm"` into a WebAssembly.Module (rule type CompiledWasm).
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}

declare module "xbrz-js" {
  export type XbrzConfig = {
    equalColorTolerance: number;
    centerDirectionBias: number;
    steepDirectionThreshold: number;
    dominantDirectionThreshold: number;
    oobRead: "auto" | "duplicate" | "transparent";
  };
  export const xbrzColorFormat: { rgb: "rgb"; argb: "argb"; argbUnbuffered: "argbUnbuffered" };
  export function xbrzConfig(opts?: Partial<XbrzConfig>): XbrzConfig;
  export function xbrzScale(
    scale: number,
    src: Uint32Array,
    dst: Uint32Array,
    width: number,
    height: number,
    colorFormat: "rgb" | "argb" | "argbUnbuffered",
    config?: XbrzConfig,
  ): void;
}
