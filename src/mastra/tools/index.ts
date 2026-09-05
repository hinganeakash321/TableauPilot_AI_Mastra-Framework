/**
 * All TableauPilot tools, aggregated for agent + Studio registration.
 */

import { workbookTools } from "./workbookTools.js";
import { datasourceTools } from "./datasourceTools.js";
import { worksheetTools } from "./worksheetTools.js";
import { buildTools } from "./buildTools.js";
import { dashboardTools } from "./dashboardTools.js";
import { dataTools } from "./dataTools.js";
import { deploymentTools } from "./deploymentTools.js";

export const allTools = {
  ...workbookTools,
  ...datasourceTools,
  ...worksheetTools,
  ...buildTools,
  ...dashboardTools,
  ...dataTools,
  ...deploymentTools,
};

export {
  workbookTools,
  datasourceTools,
  worksheetTools,
  buildTools,
  dashboardTools,
  dataTools,
  deploymentTools,
};
