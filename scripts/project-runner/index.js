const { createCommands } = require("./commands")
const { createProjectContext } = require("./context")

function main() {
  const context = createProjectContext()
  const commands = createCommands(context)
  const [commandName = "help", ...args] = process.argv.slice(2)
  const command = commands[commandName]

  if (!command) {
    console.error(`Неизвестная команда: ${commandName}`)
    commands.help.handler()
    process.exit(1)
  }

  return Promise.resolve()
    .then(() => command.handler(args))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    })
}

module.exports = {
  main
}
