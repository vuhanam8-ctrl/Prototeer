# Prototeer project instructions

Read README.md, HANDOFF.md and MESSAGE-CONTRACT.md before changing behavior.

- Root public/ and JavaScript modules are the active development source. Build development output in docs/dev/. Preserve the submitted docs/index.html and docs/Prototeer.zip.
- Give users generic, composable, editable tools. Demo configurations must be reproducible through normal editor controls. Keep the editor reconstruction test passing.
- Stats attach explicitly to tools; user-defined tags and names have no hidden built-in meaning.
- Behavior trees and utility scoring cooperate. Directors are optional. Deliver only explicitly configured message data; keep diagnostic coordinates and source identities separate.
- Use readable contrasting UI, monochrome defaults and user-uploaded artwork. Keep user-written descriptions. Avoid decorative/system explanatory copy scattered through forms.
- Preserve user projects and use rollback commits for substantial changes. Do not assume local changes are deployed; verify remote state.
- No dependencies need installing. npm test validates simulation, editor reconstruction, persistence and portable output. npm run package builds development HTML and ZIP.
