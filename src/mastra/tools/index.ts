/**
 * All TableauPilot tools, aggregated for agent + Studio registration.
 */

import { workbookTools } from "./workbookTools.js";
import { datasourceTools } from "./datasourceTools.js";
import { worksheetTools } from "./worksheetTools.js";
import { buildTools } from "./buildTools.js";
import { deploymentTools } from "./deploymentTools.js";

export const allTools = {
  ...workbookTools,
  ...datasourceTools,
  ...worksheetTools,
  ...buildTools,
  ...deploymentTools,
};

export {
  workbookTools,
  datasourceTools,
  worksheetTools,
  buildTools,
  deploymentTools,
};
