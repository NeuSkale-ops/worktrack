# Signing setup required for v0.1.2

The draft release cannot become updater-ready until its verification public key matches a protected signing private key.
No real signing key exists in the current envkit configuration.
Do not send a private key or password in chat.

## Operator actions

Use your own private terminal, not a recorded or shared terminal session.
Arrange a secure backup location before generating the key.
Run the installed Tauri signing tool interactively so the password is not included in command history:

```sh
cd /Users/sabari/Developer/worktrack
npm --prefix agent run tauri -- signer generate
```

Use a nonempty password when prompted.
The tool outputs the encoded public and private key material in your terminal.
Keep the private key confidential and store a secure backup before closing that terminal.
Do not paste it into a command argument, repository file, issue, or chat.

From the same project directory, store the encoded private key and its password through envkit's interactive prompts:

```sh
envkit set TAURI_SIGNING_PRIVATE_KEY
envkit set TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

The first value is the encoded private key itself, not the public key and not a path.
The second value is the password selected during generation.
Do not use `envkit get` or `envkit export` to display either value.

Provide only the encoded public key for embedding in `agent/src-tauri/tauri.conf.json`.
The public key is not a secret and can be shared separately.
Losing the private key can prevent future updates to installations that trust its public key.
Do not replace the key after distribution without a planned migration.

## Remaining operator setup

Protected GitHub signing and deployment environments, verified host keys, restricted deployment accounts, and Windows staging acceptance are also required.
Follow `deploy/UPDATES.md` before transferring signing credentials to GitHub or publishing files.
Do not put signing secrets in repository-wide GitHub secrets or the ordinary unsigned CI workflow.
No paid Windows publisher certificate is required for these updater signatures.
SmartScreen behavior is a separate concern.
