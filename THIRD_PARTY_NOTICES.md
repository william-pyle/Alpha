# Third-party notices

Alpha is derived from the MIT-licensed MrMak 0.5.1 application. The original
copyright notice is retained in [LICENSE](LICENSE).

The shared library contains reusable material from the official MrMak repository.
Its img2threejs module retains its Apache-2.0 license and notices in
`shared-library/.agents/skills/img2threejs/`. Source: https://github.com/img2threejs/img2threejs.

JavaScript and Rust dependencies are recorded in their lockfiles and retain
their respective licenses. The packaged Node runtime includes NODE-LICENSE.txt.

The Alpha android head in `public/models/alpha-head/` was generated with Tripo
v3.1 for this project. Its transparent application icon is a render of that
model. No reference photograph is bundled as a face texture.

Local face tracking bundles MediaPipe Tasks Vision 1.2.3 WebAssembly files
(Apache-2.0) and the BlazeFace short-range model. Their source locations are
recorded in `public/models/face-detector/README.txt`.

Local Whisper setup downloads Python 3.12.10 from python.org, faster-whisper
1.2.1 and its Python dependencies from PyPI, and the multilingual small model
from `Systran/faster-whisper-small` on Hugging Face. These are separate per-user
downloads, not included in the installer archive. The model is MIT-licensed;
see its model card and each package's license for details.

The Windows installer template is adapted from Tauri CLI 2.11.4, commit
8909f221d1515955fc843808032bdc5d62209c96. Its MIT license is retained in
`src-tauri/installer/TAURI-LICENSE-MIT`; the source URL is recorded in the template.

Codex, Claude Code, PowerShell and Git for Windows are separate products.
Alpha does not bundle provider accounts or grant access to their services.

The Smurfs and Higurashi themes use generated illustrations of Papa Smurf and
Rena. The named characters and franchises belong to their respective owners;
the application's MIT license does not grant rights to those characters.

This is an independent application, not an official product of those providers
or franchises.
