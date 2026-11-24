# Working on Cyberverse

Read `README.md` (what the game is and how to run it) and `DECISIONS.md`
(what Cyberverse may and may not do) before changing anything.

## Notes from the notes pad

The people building Cyberverse ask for changes with the ✎ notes pad while they
play (`ui/notepad.js`, `src/server/notes.ts`). Notes are saved on their
computer, in this folder:

- `notes/ui-notes.md`: how it looks and works (layout, colours, screens).
- `notes/practicals-notes.md`: the floors themselves (steps, wording, the
  attack, the marking).
- `notes/shots/`: the screenshots. Open them: the red boxes show exactly what
  a note means.

Each entry starts with `### <date> <time> - <who>`, then `## Screen: <screen>`
and a list of where they were (tower, floor, guide step, open room or machine,
game clock), then the note, then `---`.

For each new note: make the change, run the tests, push to the working branch,
and tell them which note it answers and where to look. `npm run dev` on their
computer pulls the change and reloads the page. `notes/` is git-ignored: never
commit it.
