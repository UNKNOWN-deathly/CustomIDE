export type CommandId = string;

export interface CommandContext {
  log?: (message: string) => void;
}

export interface Command {
  id: CommandId;
  label: string;
  shortcut?: string;
  enabled?: () => boolean;
  run: () => unknown | Promise<unknown>;
}

export class CommandRegistry {
  private readonly commands = new Map<CommandId, Command>();

  register(command: Command): void {
    if (this.commands.has(command.id)) {
      throw new Error(`Command already registered: ${command.id}`);
    }
    this.commands.set(command.id, command);
  }

  get(id: CommandId): Command | null {
    return this.commands.get(id) ?? null;
  }

  enabled(id: CommandId): boolean {
    const command = this.get(id);
    if (!command) return false;
    return command.enabled ? command.enabled() : true;
  }

  async execute(id: CommandId): Promise<boolean> {
    const command = this.get(id);
    if (!command || !this.enabled(id)) return false;
    await command.run();
    return true;
  }
}

export function registerDisabledCommand(
  registry: CommandRegistry,
  id: CommandId,
  label: string,
  context: CommandContext,
  shortcut?: string,
): void {
  registry.register({
    id,
    label,
    shortcut,
    enabled: () => false,
    run: () => {
      context.log?.(`${label} is not implemented yet.`);
    },
  });
}
