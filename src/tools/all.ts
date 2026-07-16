import { Tool } from "./index.js";
import { bashTool } from "./bash.js";
import { editFileTool, listFilesTool, readFileTool, writeFileTool } from "./fs.js";
import { spawnAgentTool } from "./spawn_agent.js";
import { testGameTool } from "./test_game.js";
import { playGameTool } from "./play_game.js";
import { updateTasksTool } from "./tasks.js";

/** The full tool set every benchmarked model gets — identical across models. */
export function defaultTools(): Tool[] {
  return [
    bashTool,
    readFileTool,
    writeFileTool,
    editFileTool,
    listFilesTool,
    spawnAgentTool,
    testGameTool,
    playGameTool,
    updateTasksTool,
  ];
}
