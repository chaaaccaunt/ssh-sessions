const { createProjectConfig } = require("./config")
const { createWorkspaceContext } = require("./workspaces")

function createProjectContext() {
  const config = createProjectConfig()
  const workspaces = createWorkspaceContext(config)

  return {
    config,
    workspaces
  }
}

module.exports = {
  createProjectContext
}
