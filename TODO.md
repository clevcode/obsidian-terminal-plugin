Support for adding an arbitrary number of custom commands, to allow for leveraging the full power of terminal-based tools such as fzf and ripgrep for blazing fast search, triggering git and other version control system commands, running makefiles, running file processing and converter tools in general, and so on.

These custom commands can then be bound to hotkeys through the regular Obsidian settings.

Configurable options per-command should include:
- Optional input through dialog popup before running command
- Optional arguments through dialog popup before running command
- Sending current selection to stdin
- Sending current note to stdin
- Interactive command or read-only
- Shift focus to terminal window running command or not
- Show terminal in split down/right, new tab, new popout window
- Show/hide the tab group header for the terminal
- Within the command line, allow using variables for:
    - Vault path
    - Current folder
    - Current filename
- Toggle for allowing global hotkeys within the terminal
    - If not, configurable hotkey for shifting focus to Obsidian

Other basic stuff:
- Configure font size
- Dynamic changing of font size

Note that my time is very limited, so contributing to the development of this plugin is very welcome. I think there is a lot of potential to really combine the power of Obsidian with the power of traditional command line based tools and editors.
