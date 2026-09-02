# pi-stack

A collection of skills, extensions, and setup scripts for the [pi coding agent](https://github.com/earendil-works/pi).

The package currently includes:

- `blind`, an extension that hides project context for general questions
- `brainstorm`, a skill to form ideas into plans
- `writing`, a skill for removing common AI writing patterns and producing clearer prose
- `pi-sandbox.sh`, a Linux launcher that runs the entire pi process inside a Bubblewrap sandbox

## Requirements

- Linux
- [pi](https://github.com/earendil-works/pi-mono) installed at `${HOME}/.local/bin/pi`
- [Bubblewrap](https://github.com/containers/bubblewrap) available as `bwrap`

Install Bubblewrap with your system package manager. For example:

```bash
# Arch Linux
sudo pacman -S bubblewrap

# Debian or Ubuntu
sudo apt install bubblewrap

# Fedora
sudo dnf install bubblewrap
```

## Installation

Clone the repository, install it as a pi package, then install the sandbox launcher:

```bash
git clone <repository-url> pi-stack
cd pi-stack
pi install .
./scripts/init.sh
```

`init.sh` creates this symlink:

```text
${HOME}/.config/pi/bin/pi -> <pi-stack>/scripts/pi-sandbox.sh
```

It will update an existing symlink, but it will not replace a regular file at that path.

Add `${HOME}/.config/pi/bin` before the real pi binary in your `PATH`:

```bash
export PATH="${HOME}/.config/pi/bin:${PATH}"
```

Add that line to your shell configuration to keep it across restarts. Run `hash -r` after installation if your shell cached the old `pi` path.

Verify the launcher:

```bash
command -v pi
pi --version
```

`command -v pi` should print `${HOME}/.config/pi/bin/pi`.

## Usage

Start pi from the directory you want to use as the workspace:

```bash
cd /path/to/project
pi
```

Arguments pass through to the real pi executable:

```bash
pi --continue
pi -p "Review this project"
```

Start pi from the repository root when you want project resources such as `.pi` and `.agents/skills` to be available.

## Hiding project context

Run `/blind` to toggle blind mode.

While project context is hidden, pi:

- sends a clean system prompt without the working directory or project instructions
- excludes conversation messages from before the mode was enabled
- keeps active user-scoped tools from global extensions and packages available
- disables and blocks built-in, temporary, and project-scoped tools
- blocks project-scoped skills and prompt templates
- skips compaction and tree summaries that could read older project context

The footer shows `blind` while the mode is active. Globally installed tools such as `question` remain available if they were active before blind mode or become active while it is running. Other tool access returns to its previous state when you turn blind mode off. The setting is stored in the session, so resumed sessions keep the same mode.

Start pi with `--blind` to hide project context immediately:

```bash
pi --blind
```

This mode removes Pi's automatic project context, but it is not a security boundary. User-scoped tools remain callable, and their results are sent to the model. A globally installed tool can still read the project if its implementation permits it, so only install tools you trust. Project-scoped extension commands also run before blind mode can intercept input; do not invoke them when project context must stay hidden.

Extensions run inside the Pi process with its filesystem permissions. Use the Bubblewrap launcher when you need process-level filesystem isolation.

## Sandbox behavior

The launcher runs the whole pi process inside Bubblewrap. Built-in tools, extension tools, hooks, skill scripts, and shell commands all run within the same boundary.

The sandbox grants:

- read and write access to the current working directory
- read-only access to `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}`
- read-only access to `${HOME}/.local` and `${HOME}/.agents`
- read-only access to system files under `/usr`, `/etc`, and `/opt`
- write access to pi's `auth.json`, `sessions`, and `trust.json`
- temporary storage under `/tmp`
- normal network access for model calls and web tools

The launcher sets `PI_OFFLINE=1` to stop pi from performing package updates and other startup network operations inside the read-only configuration directory. Model calls and extension network requests still work.

Files elsewhere in the home directory are not mounted. Tools that depend on files outside the workspace may need another read-only mount in `scripts/pi-sandbox.sh`.

## Security limits

The sandbox limits filesystem and process access, but it does not restrict the network. Pi and its extensions can read the credentials needed for model access. A malicious extension could send those credentials over the network.

Review extensions and skills before installing them. Use a network-controlled sandbox or an inference proxy if credentials must stay outside the pi process.

## Updating

Update the repository or installed pi package as usual. Run the initialization script again if the package location changes:

```bash
./scripts/init.sh
```

## Removing the launcher

Remove the symlink to return to the original pi executable:

```bash
rm "${HOME}/.config/pi/bin/pi"
hash -r
```

Then remove the package from pi if needed:

```bash
pi remove /absolute/path/to/pi-stack
```
