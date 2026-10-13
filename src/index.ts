import { Plugin } from "@opencode/plugin"
import { setupV2 } from "./v2.ts"

// OpenCode validates and calls id + setup().
export default Plugin.define({
  id: "cioffi.rem-memory",
  setup: setupV2,
})
