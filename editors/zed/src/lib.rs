//! Zed extension for Mynt: registers the Mynt language (grammar and queries
//! live under `languages/mynt`) and starts `mynt lsp` as its language server.
//!
//! The executable is resolved in this order:
//!
//! 1. Zed's standard language-server configuration, `lsp.mynt.binary` in
//!    settings (`path`, optional `arguments` and `env`);
//! 2. `mynt` on the worktree's PATH, which is where a global
//!    `npm install -g @felixdivall/mynt` puts it;
//! 3. `MYNT_LSP_PATH` in the shell environment, a development fallback that
//!    names a local build such as `<repo>/bin/mynt.js`.

use zed_extension_api::{self as zed, settings::LspSettings, LanguageServerId, Result};

struct MyntExtension;

impl zed::Extension for MyntExtension {
    fn new() -> Self {
        MyntExtension
    }

    fn language_server_command(&mut self, id: &LanguageServerId, worktree: &zed::Worktree) -> Result<zed::Command> {
        let binary = LspSettings::for_worktree(id.as_ref(), worktree).ok().and_then(|settings| settings.binary);
        let configured_path = binary.as_ref().and_then(|b| b.path.clone());
        let args = binary.as_ref().and_then(|b| b.arguments.clone()).unwrap_or_else(|| vec!["lsp".to_string()]);
        let mut env = worktree.shell_env();
        if let Some(extra) = binary.and_then(|b| b.env) {
            env.extend(extra);
        }
        let development = env.iter().find(|(key, _)| key == "MYNT_LSP_PATH").map(|(_, value)| value.clone());

        let command = configured_path
            .or_else(|| worktree.which("mynt"))
            .or(development)
            .ok_or_else(|| {
                "mynt was not found. Install it with `npm install -g @felixdivall/mynt`, or set `lsp.mynt.binary.path` in Zed settings to the executable.".to_string()
            })?;
        Ok(zed::Command { command, args, env })
    }
}

zed::register_extension!(MyntExtension);
