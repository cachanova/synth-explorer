# Production operations

Synth Explorer runs on one Hetzner CX33 in Helsinki. Caddy accepts public
traffic on ports 80 and 443. The application container serves the React build,
the Rust API, and bounded Yosys jobs on an internal Docker network.

Cloudflare holds the `synthexplorer.dev` registration and authoritative DNS.
Keep each production record in **DNS only** mode. Caddy, rather than the
Cloudflare proxy, obtains and renews the TLS certificate.

## Service inventory

| Component | Location | Purpose |
| --- | --- | --- |
| Domain and DNS | Cloudflare | Registration, DNSSEC, A/AAAA/CNAME records |
| VM and firewall | Hetzner Cloud | Ubuntu host and network policy |
| Source and automation | GitHub | CI, deployment, monitoring, Dependabot |
| Images | GHCR package | Immutable production images |
| TLS and routing | Caddy container | Certificates, redirects, reverse proxy |
| Application | Synth Explorer container | Static UI, API, and Yosys |

The production stack has no database. The server keeps synthesized designs in
memory and discards them on restart.

## One-time account setup

Enable 2FA, recovery codes, and billing alerts on Cloudflare, Hetzner, and
GitHub. Keep the Hetzner API token on an administrator workstation. GitHub
deployments need SSH access to the VM but do not need a Hetzner API token.

The repository publishes images under:

```text
ghcr.io/cachanova/synth-explorer:<full-git-commit>
```

GHCR creates a private package on the first publish. During a deployment, the
workflow authenticates the host with its job-scoped `GITHUB_TOKEN`, pulls the
immutable digest, and logs the host out even if deployment fails. No long-lived
registry credential remains on the server. You may make the package public in
GitHub's package settings so others can pull it anonymously; that visibility
change is permanent and is not required for production.

## Cloudflare DNS

Create these records after Hetzner assigns the VM addresses:

| Type | Name | Content | Proxy status | TTL |
| --- | --- | --- | --- | --- |
| A | `@` | Hetzner public IPv4 | DNS only | 300 during launch |
| AAAA | `@` | VM IPv6 address | DNS only | 300 during launch |
| CNAME | `www` | `synthexplorer.dev` | DNS only | 300 during launch |

Copy the IPv6 address from the server or Hetzner Console. Do not infer an
address from the assigned `/64` range. Raise the TTL to 3600 after the first
deployment passes its smoke test.

Cloudflare Registrar enables DNSSEC for domains that use Cloudflare DNS. Confirm
that the dashboard reports DNSSEC as active. Leave proxying, Workers, redirects,
and SSL termination off. Caddy redirects `www` to the apex domain and redirects
HTTP to HTTPS.

The `.dev` registry uses HSTS. Browsers require a valid HTTPS endpoint, so start
Caddy before testing the domain in a browser.

## Provision Hetzner

Run the provisioning commands from the repository root with the authenticated
`synthexplorer` hcloud context. Choose the SSH key that already exists in the
Hetzner project.

Create a firewall. GitHub-hosted deployment runners do not have a stable source
address, so SSH must remain reachable publicly for this deployment model. The
host accepts keys only, disables root login, and uses a dedicated deployment
key with strict host-key checking. Cloud-init validates the provisioned key and
the effective sshd policy before disabling root access; a failure leaves the
existing root policy in place for Hetzner-console recovery. The `deploy` user has
Docker access but no sudo grant. Docker access is itself root-equivalent, so use
it only through the checked-in deployment scripts.

```bash
hcloud firewall create --name synth-explorer-prod
hcloud firewall add-rule synth-explorer-prod \
  --direction in --protocol tcp --port 22 \
  --source-ips 0.0.0.0/0 --source-ips ::/0 --description "Key-only SSH deployment"
hcloud firewall add-rule synth-explorer-prod \
  --direction in --protocol tcp --port 80 \
  --source-ips 0.0.0.0/0 --source-ips ::/0 --description "HTTP certificate and redirect"
hcloud firewall add-rule synth-explorer-prod \
  --direction in --protocol tcp --port 443 \
  --source-ips 0.0.0.0/0 --source-ips ::/0 --description "HTTPS"
hcloud firewall add-rule synth-explorer-prod \
  --direction in --protocol udp --port 443 \
  --source-ips 0.0.0.0/0 --source-ips ::/0 --description "HTTP/3"
```

Check CX33 availability before creating the server. Create it with Ubuntu 24.04,
both public address families, deletion protection, and the checked-in cloud-init
configuration:

```bash
export HCLOUD_SSH_KEY='leela@zen'

hcloud server create \
  --name synth-explorer-prod \
  --type cx33 \
  --image ubuntu-24.04 \
  --location hel1 \
  --ssh-key "$HCLOUD_SSH_KEY" \
  --firewall synth-explorer-prod \
  --enable-protection delete \
  --enable-protection rebuild \
  --user-data-from-file deploy/ops/cloud-init.yml
```

The command creates a billable server. Record its IPv4 and IPv6 information:

```bash
hcloud server describe synth-explorer-prod
```

If direct CX33 creation is temporarily unavailable, create a CX23 with the same
command, wait for cloud-init, then resize it without changing its addresses or
SSH identity:

```bash
hcloud server poweroff synth-explorer-prod
hcloud server change-type synth-explorer-prod cx33
hcloud server poweron synth-explorer-prod
```

The resize expands the disk and cannot be reversed to a smaller disk shape.
Verify `nproc`, `/proc/meminfo`, `lsblk`, and `df -h /` before publishing DNS.

Wait for cloud-init, then confirm Docker and the deployment directory:

```bash
ssh deploy@SERVER_IPV4 'cloud-init status --wait'
ssh deploy@SERVER_IPV4 'docker version && docker compose version'
ssh deploy@SERVER_IPV4 'test -w /opt/synth-explorer'
```

Do not publish the DNS records until these checks pass. Publish them before the
first deployment so Caddy can obtain a certificate and the host-side smoke test
can reach the public URL.

## Dedicated deployment SSH key

Use a dedicated Ed25519 key for GitHub Actions. Keep the private key out of the
repository and off the VM.

```bash
ssh-keygen -t ed25519 -f ./synth-explorer-deploy -C github-production -N ''
ssh deploy@SERVER_IPV4 'umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys' \
  < ./synth-explorer-deploy.pub
```

Confirm the new key in a second terminal before closing the administrator
session:

```bash
ssh -i ./synth-explorer-deploy deploy@SERVER_IPV4 'id && test -w /opt/synth-explorer'
```

Use the Hetzner web console to read the host's Ed25519 fingerprint:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

Compare that fingerprint with the first SSH connection. Save the matching host
key for GitHub:

```bash
ssh-keyscan -H SERVER_IPV4 > ./synth-explorer-known-hosts
ssh-keygen -lf ./synth-explorer-known-hosts
```

Delete the local deployment private key after GitHub stores it and a deployment
succeeds. Root-only host maintenance uses the Hetzner console unless you
separately provision a dedicated administrator account.

## GitHub production environment

Create an environment named `production` in the repository settings. Limit its
deployment branches to `main`. Add an approval rule if you want each merged
commit to wait before deployment.

Add these environment secrets:

| Secret | Value |
| --- | --- |
| `PRODUCTION_SSH_KEY` | Contents of `synth-explorer-deploy` |
| `PRODUCTION_KNOWN_HOSTS` | Verified `ssh-keyscan -H` output |

Add these environment variables:

| Variable | Value |
| --- | --- |
| `PRODUCTION_HOST` | Hetzner public IPv4 or stable SSH hostname |
| `PRODUCTION_USER` | `deploy` |

The GitHub CLI can populate the environment after you create it:

```bash
gh secret set PRODUCTION_SSH_KEY --env production < ./synth-explorer-deploy
gh secret set PRODUCTION_KNOWN_HOSTS --env production < ./synth-explorer-known-hosts
gh variable set PRODUCTION_HOST --env production --body SERVER_IPV4
gh variable set PRODUCTION_USER --env production --body deploy
```

Protect `main` with the Backend, Frontend, and Production image CI checks. Block
force pushes, require pull requests, require branches to be current, and apply
the rule to administrators. A successful push-triggered CI run on `main` starts
the deployment workflow for that exact commit; failed, cancelled, pull-request,
and manually dispatched CI runs do not deploy.

## First deployment

The production workflow performs these steps:

1. Builds one `linux/amd64` image with the full Git commit embedded in
   `/healthz`.
2. Runs all seven synthesis modes and a browser test that enters `-noabc` in
   the webpage against that image.
3. Pushes the full-commit tag to GHCR and resolves its `sha256` digest.
4. Uploads `compose.prod.yml`, `Caddyfile`, and the scripts under `ops/` over
   SSH.
5. Calls `ops/deploy.sh <image-ref@sha256:digest>` on the host.
6. Verifies the IPv6 HTTPS path from the host, then verifies public DNS, TLS,
   HTTP and `www` redirects, all synthesis modes, and the deployed commit from a
   GitHub runner.

The first successful `main` CI run publishes and deploys automatically. To
redeploy the current, already-CI-verified `main` commit manually:

```bash
gh workflow run deploy-production.yml --ref main -f publish_only=false
```

Select the new run in GitHub Actions and confirm that both jobs pass.

The host deploy script accepts an immutable digest reference. It rejects tags,
unpacks each workflow run under `/opt/synth-explorer/releases/`, stores mutable
state under `/opt/synth-explorer/state/`, starts the Compose project, and runs
health and synthesis checks. For routine deploys, the `/opt/synth-explorer/current`
symlink moves only after the public smoke test passes. If the new release fails,
the script restores both the prior image reference and the prior release directory
before returning an error. The host keeps the active and immediately previous
release bundles and image digests; older Synth Explorer releases are removed
after a successful deployment. A verified rollback clears obsolete transition
metadata and removes only the failed digest; a rollback that cannot restore a
verified stack retains both images for recovery. Compose restarts use local
digests and do not need a persistent GHCR credential.

On the first deployment, a locally healthy stack is left running only when its
exact public health response cannot yet be verified. That lets Caddy keep
serving ACME challenges while DNS/TLS converges. If exact public health works but
the synthesis smoke fails, the script stops the stack and clears its state.

Verify the release from an administrator workstation:

```bash
curl --fail --silent --show-error https://synthexplorer.dev/healthz | jq
./deploy/ops/smoke-test.sh https://synthexplorer.dev "$(git rev-parse origin/main)"
```

The health response must report `status: ok`, the deployed commit, and a Yosys
version.

## Routine deployments and rollback

Merge through a pull request. CI checks Rust formatting, tests, Clippy,
frontend tests, lint, types, the production build, and the production container
smoke test. Only a successful push-triggered CI run for the exact `main` commit
starts a production build and deployment; the deployment does not race ahead of
the full CI result. A rerun of an old CI workflow never redeploys that old SHA.
After a successful rerun for the current `main`, use the manual deployment
command above; it independently requires a successful push CI result for that
exact commit. A deployment that becomes stale while building exits before SSH
or host mutation, allowing the newest green commit to deploy instead.

Watch a deployment:

```bash
gh run list --workflow deploy-production.yml --limit 5
gh run watch RUN_ID --exit-status
```

The deploy script rolls back when startup or smoke verification fails. The
workflow also invokes rollback when its outside-host verification fails. To
manually restore the immediately previous verified release, invoke the active
release script with the shared base directory:

```bash
ssh deploy@SERVER_IPV4
SYNTH_EXPLORER_BASE_DIR=/opt/synth-explorer \
  /opt/synth-explorer/current/ops/deploy.sh --rollback
```

The command fails clearly when no previous release is available. Deploying an
older digest outside the one-release rollback window requires a temporary GHCR
login before invoking `current/ops/deploy.sh <image@digest>` with the same
`SYNTH_EXPLORER_BASE_DIR`; log out again afterward. Run the external smoke test
with the commit embedded in that image. Record the reason and digest in the
related GitHub issue.

Do not deploy `latest` or a commit tag to the host. Tags can move. The digest
pins the bytes that passed the release smoke test.

## Monitoring

GitHub Actions requests `/healthz` every 15 minutes. Every six hours it also
runs a synthesize-to-design-fetch smoke test. GitHub sends workflow failure
notifications according to repository notification settings. The scheduler can
start late during GitHub Actions congestion, so treat it as a low-cost uptime
check rather than a paging system.

Inspect the host when a monitor fails:

```bash
ssh deploy@SERVER_IPV4
docker compose --project-directory /opt/synth-explorer/current \
  --file /opt/synth-explorer/current/compose.prod.yml \
  --env-file /opt/synth-explorer/state/.env ps
docker compose --project-directory /opt/synth-explorer/current \
  --file /opt/synth-explorer/current/compose.prod.yml \
  --env-file /opt/synth-explorer/state/.env logs --since 30m --tail 300
docker stats --no-stream
df -h /
free -h
```

Application logs include request metadata and synthesis outcomes. They must not
contain submitted RTL. Caddy access logs and Docker container logs use bounded
rotation configured in `compose.prod.yml`.

## Host and dependency updates

Ubuntu installs security updates through unattended upgrades. Check the reboot
marker once a month and after a kernel or Docker update:

```bash
ssh deploy@SERVER_IPV4 'test ! -f /var/run/reboot-required || cat /var/run/reboot-required.pkgs'
```

Before a planned reboot, confirm the current digest and a recent smoke test.
Reboot from the Hetzner console or a separately provisioned administrator
account, then rerun the external smoke test. The deployment account intentionally
has no sudo grant.

Dependabot opens weekly Cargo, npm, Docker, and GitHub Actions updates. Review
and merge those pull requests through the same CI path. The workflow pins each
third-party action to a commit SHA; keep the version comment beside each pin
when Dependabot updates it.

Check disk use before pruning images:

```bash
docker system df
docker image prune --filter 'until=168h'
```

Do not run `docker system prune --all` during an incident. It can remove the
prior image needed for a fast rollback.

## Incident handling

### Site or health endpoint is down

1. Check the GitHub monitor and deployment runs.
2. Check `docker compose ps`, application logs, Caddy logs, disk, and memory.
3. Restart the same Compose project if the containers stopped without a bad
   release.
4. Roll back to the prior digest if the failure followed a deployment.
5. Use the Hetzner console when SSH is unavailable.

### TLS fails

Confirm that Cloudflare records remain DNS only and point to the VM. Confirm
that ports 80 and 443 reach Caddy. Inspect Caddy logs and check the server clock.
Do not place Cloudflare proxy TLS in front of Caddy as an incident workaround.

### Synthesis requests fail or exhaust resources

Check queue rejection, timeout, and OOM messages in the application logs. Check
`docker stats` before restarting. Preserve the failing request metadata without
copying user RTL into an issue. Roll back if the rate changed after a release.
If hostile traffic persists, restrict ports 80 and 443 in the Hetzner firewall
while you investigate.

### Disk fills

Inspect Docker usage and rotated logs. Remove build cache and images older than
the rollback window. Keep the running image and at least one known-good prior
digest on disk.

## Recovery and backups

The project does not pay for VM backups at launch. GitHub stores the source and
workflow history. GHCR stores release images. Cloudflare stores DNS. The server
stores designs in memory, and a backup could retain submitted RTL that users
expect the service to discard.

Use a temporary Hetzner snapshot before an OS or Docker change that has a high
recovery cost. Delete the snapshot after the service passes its smoke test.

Replace a lost VM with this procedure:

1. Create the firewall and CX33 from `deploy/ops/cloud-init.yml`.
2. Confirm Docker, SSH, and `/opt/synth-explorer`.
3. Install a new dedicated deployment key and update the two GitHub environment
   secrets.
4. Update `PRODUCTION_HOST`.
5. Point Cloudflare A and AAAA records to the replacement VM.
6. Run `deploy-production.yml` for `main`.
7. Verify HTTPS and the synthesis smoke test, then delete the failed server.

Aim for a 30-minute recovery. DNS TTL and Hetzner capacity set the lower bound.
