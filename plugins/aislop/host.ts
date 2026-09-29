import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./contract.js";
import { exec, scan } from "./src/scan.js";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    scan: (input, context) => scan(input, exec, context.signal),
  },
});
