# Diary Feed

Diary Feed is a single chronological surface for reading and writing Obsidian Daily Notes. It treats the dated Markdown files as the source of truth without exposing their metadata as diary content.

## Language

**Diary Folder**:
The single configured folder whose direct children are the exclusive source of Diaries.
_Avoid_: Vault folder, notes directory

**Diary**:
A direct child of the Diary Folder whose filename is a calendar date in `YYYY-MM-DD.md` form.
_Avoid_: Journal entry, daily file

**Diary Feed**:
The continuous collection of Diaries ordered from the newest diary date to the oldest.
_Avoid_: Timeline, journal page

**Diary Body**:
The user-authored Markdown content of a Diary, excluding its frontmatter block.
_Avoid_: Note content, raw file

**External Change**:
A new version of a Diary produced outside the current editing session.
_Avoid_: Remote edit, conflicting file

**Edit Conflict**:
The state in which unsaved Diary Body edits coexist with an External Change to the same Diary.
_Avoid_: Sync error, duplicate version
