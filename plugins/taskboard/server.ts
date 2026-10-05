import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { registerBackgroundSync } from './server/background.js';
import { registerCli } from './server/cli.js';
import { createTaskboardContext } from './server/context.js';
import { registerMentionProvider } from './server/mention.js';
import { registerRpc } from './server/rpc.js';

export { formatFilterPresetCliJson } from './server/cli-format.js';
export {
  parseTaskboardCliArguments,
  resolvePresetListSelection
} from './server/cli-args.js';

export default async function plugin(bb: BbPluginApi) {
  const tc = createTaskboardContext(bb);
  registerRpc(tc);
  registerMentionProvider(tc);
  registerCli(tc);
  registerBackgroundSync(tc);

  bb.log.info(
    'Taskboard registered project-scoped Linear, GitHub, and Jira sources'
  );
}
