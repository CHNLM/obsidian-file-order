import "./process-polyfill";
import { FileOrder } from "./fileOrder";
import { FileOrderSettingTab } from "./fileOrderSettingTab";

// Re-export FileOrderSettingTab so its class name survives the esbuild
// minifier. Without this, debug stack traces inside the settings UI show
// mangled single-letter names; the display() implementation itself is
// preserved regardless because it is referenced through Plugin.addSettingTab.
export { FileOrderSettingTab };

export default FileOrder;
