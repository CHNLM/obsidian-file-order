import "./process-polyfill";
import { FileOrder } from "./fileOrder";
import { FileOrderSettingTab } from "./fileOrderSettingTab";

// Re-exported from the plugin entry point so the settings tab class stays
// reachable from the bundle. The tab itself is registered by
// Plugin.addSettingTab in fileOrder.ts.
export { FileOrderSettingTab };

export default FileOrder;
