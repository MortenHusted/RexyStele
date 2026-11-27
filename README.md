# RexyStele

See which statements of a Stele catalog your change touches, in a [Rex](https://www.superlogical.com/rex) pane with one key. A sibling of RexySesh, RexyTask and RexyCamp.

Focus a pane in a Git worktree and press <kbd>Shift</kbd>+<kbd>Cmd</kbd>+<kbd>E</kbd> to open the view in a floating pane. Press it again to close it.

The view only reads. It runs `stele intent impact` for the directory of the focused pane, and runs it again when the branch moves or a tracked file changes.

## What it shows

- **Header**: the branch, what it is compared with, how many statements the change touches, how much changed code no statement maps, and how many statements await approval.
- **Touched**: the touched statements, grouped by the catalog file they live in. `✗` marks a statement whose mapped code was removed, `●` one whose mapped code changed. Below them, the changed code that no statement maps.
- **Statement**: the selected statement's text, the statement it refines, the sources its comment cites, every piece of code it maps to, and the diff of just the lines that were touched. For unmapped code it shows the file's diff.

## Checking a worktree plan

Press <kbd>p</kbd> to see the plans in the focused worktree’s `plans/` directory.
A single `.stele` plan opens directly. If several are present, use the arrow
keys to choose one and press Enter. The view shows the plan source and the
output of `stele plan check` for that file. This works in worktrees without
an intent catalog.

Press <kbd>r</kbd> after editing to read the file and check it again.
Press <kbd>p</kbd> to return to catalog impact.

## What a change is compared with

The view never compares two branch tips. It compares your branch with the commit where it left the base branch (`git merge-base`), so work that landed on the base branch since then does not show up as yours. Press <kbd>b</kbd> to compare with the commit before the last one instead, or to see only uncommitted changes.

The base branch is the remote's default branch, then `master`, then `main`. Set `base_branch` when that guess is wrong.

## Where the catalog is read from

The catalog is `intent/catalog.stele` in the worktree of the focused pane. When that worktree has none, the catalog of the repository's main worktree is used, which is what you want while a catalog is not committed. In that case only commits can be compared: the header says `commits only`, and how many uncommitted files were left out.

## Keys

| Key | Action |
| --- | --- |
| <kbd>↑</kbd> <kbd>↓</kbd>, <kbd>j</kbd> <kbd>k</kbd> | Select a statement |
| <kbd>g</kbd> <kbd>G</kbd> | First, last |
| <kbd>J</kbd> <kbd>K</kbd>, <kbd>Space</kbd>, <kbd>PgUp</kbd> <kbd>PgDn</kbd> | Scroll the statement |
| <kbd>b</kbd> | Change what the branch is compared with |
| <kbd>r</kbd> | Ask Stele again |
| <kbd>Enter</kbd> | Open the changed code |
| <kbd>c</kbd> | Open the statement in the catalog |
| <kbd>y</kbd> | Copy the statement's id |
| <kbd>q</kbd> | Close |

## Install

You need [Bun](https://bun.sh) to build the viewer, and `stele` on your `PATH`.

```sh
./install.sh
```

The installer builds `bin/rexystele`, copies two Lua files into Rex's config directory (`~/.config/rex` by default), adds `require("rexystele")` to `init.lua`, and reloads Rex. Run it again after you pull an update, or after you move this folder.

To remove everything: `./uninstall.sh`.

## Settings

Edit `~/.config/rex/rexystele.lua`, then run `rex config reload`.

| Setting | Meaning |
| --- | --- |
| `key` | The key of the toggle, or `false` for none. `shift+cmd+e` when unset. |
| `placement` | `overlay`, `split`, `zoomed` or `tab`. |
| `direction` | Of `split` and `zoomed`: `right` or `down`. |
| `ratio` | The share of the split that RexyStele gets. |
| `base_branch` | The branch a change is compared with. |
| `editor` | The editor that <kbd>Enter</kbd> and <kbd>c</kbd> open files in, at the right line: `rubymine`, `idea`, `webstorm`, `vscode`, `cursor`, `zed` or `sublime`. Or a command of your own with `{file}` and `{line}` in it, such as `nvim +{line} {file}`. The system's default app when unset. |

## Without Rex

```sh
bin/rexystele --cwd path/to/repository          # the view, in any terminal
bin/rexystele --cwd path/to/repository --json   # the same answer once, as JSON
```

## Develop

```sh
bun test
bun run typecheck
bun run build
```
