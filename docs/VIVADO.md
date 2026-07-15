# Vivado backend

Synth Explorer can optionally run AMD Vivado, export the synthesized structural
Verilog, and normalize it to the same Yosys JSON contract used by every other
analysis path. At startup the server asks Vivado for its complete installed part
catalog. After owner authentication, every installed part is available in the
web target selector and enforced as a server-side allowlist.

Vivado is never copied into the application image. A deployment enables the
tool by mounting an administrator-provisioned installation and license, then
setting `VIVADO_BIN`. Without that variable, startup remains Yosys-only and the
web client hides the Vivado tool. With Vivado enabled, the server also requires
an owner access-key digest and rejects every unauthenticated Vivado request.

## Netlist path

1. A source-only Yosys pass resolves the top and retains source provenance.
2. Vivado 2026.1 runs `synth_design` and `write_verilog -mode funcsim`.
3. Yosys loads its Xilinx primitive libraries, reads the structural Verilog,
   selects only the top, and writes the canonical JSON netlist.
4. The existing parser, graph, analysis, cache, and API process that JSON.

EDIF and DCP are deliberately not interchange formats: the checked-in Yosys
build has no EDIF reader, while DCP is a Vivado-specific archive.

## Local or dedicated-worker packaging

Build the normal application image:

```bash
docker build --tag synth-explorer:vivado --file deploy/Dockerfile .
```

Keep the Vivado installation at a persistent host path containing
`2026.1/Vivado/`, and keep the generated `.lic` outside the repository. The BASIC
license is node-locked. Generate it for the hardware-backed Ethernet host ID
reported on the worker VM itself; do not use a Docker-assigned, dummy, or veth
MAC. Rehost the license through AMD before moving the worker to a VM with a
different host ID.

The Compose overlay validates the mounts and applies the worker resource
shape without adding AMD files to the image:

```bash
export IMAGE_REF=synth-explorer:vivado
export VIVADO_INSTALL_ROOT=/mnt/synth-explorer-vivado/amd/install
export VIVADO_LICENSE_FILE=/mnt/synth-explorer-vivado/amd/license/Xilinx.lic
export VIVADO_ACCESS_TOKEN_SHA256="$(printf '%s' "$VIVADO_OWNER_KEY" | sha256sum | awk '{print $1}')"

docker compose \
  -f deploy/compose.prod.yml \
  -f deploy/compose.vivado.yml \
  config
```

The license must be readable by container UID 10001. The overlay mounts both
inputs read-only, sets `XILINXD_LICENSE_FILE`, uses a 2 GiB scratch tmpfs, and
allocates 3.5 CPUs, 6 GiB RAM, and 512 PIDs. The server admits one synthesis at
a time. FlexNet's libudev host-ID scan does not work reliably from an isolated
Docker network namespace, so the overlay
uses host networking. The application binds only to `127.0.0.1:8787`, and Caddy
proxies that loopback address. The dedicated CX33 runs only this application;
tune upward only if measured designs need it.

## Owner access key

The public production interface keeps Yosys open to everyone and permits only
the maintainer to select or invoke Vivado. Generate a 256-bit hexadecimal key
once and save the raw value in the maintainer's password manager:

```bash
openssl rand -hex 32
```

Never commit, upload, or place the raw key in GitHub Actions. Production stores
only `SHA-256(key)` in
`/opt/synth-explorer/state/vivado-access-token.sha256`, owned by the deployment
user with mode `0600`. The deployment script validates that file before
starting Compose. It generates a separate ephemeral key for the deployment's
real Vivado smoke test, passes only that key's digest to the container, and
discards the raw smoke key when the deployment process exits.

The browser uses a standard single-password form when Vivado is selected, so
password managers can save and autofill the API key without a username. The raw
key remains only in that tab's memory, is transmitted over HTTPS in the
Authorization header,
and must be entered again after a reload unless the password manager fills it.
The server hashes the supplied key and compares the digest in constant time; it
never stores or logs the raw key. Someone who obtains the host-side digest
cannot submit that digest as the key because it is hashed again before
comparison.

Successful authentication returns the catalog captured from Vivado `get_parts`
at startup. The target dropdown groups all returned parts by Vivado's `FAMILY`
property. Synthesis rejects a target that is not in that startup catalog before
cache lookup or execution. The UI also provides a curated multi-select for
common `synth_design` switches; the adjacent free-form field remains available
for advanced validated flags.

On Hetzner, `/mnt/synth-explorer-vivado` should be a real attached Cloud Volume,
not a Docker named volume (which otherwise consumes the server's root disk).
Keep the installed tree on that Volume, but keep per-job scratch and `$HOME` on
local NVMe or tmpfs; Vivado performs enough small-file work that network-volume
IOPS would otherwise add avoidable latency. Hetzner server backups and snapshots
do not include attached Volumes, so preserve the verified installer/configuration
recipe and back up any non-reconstructible Volume contents separately.

The verified 2026.1 installation containing 7-Series, UltraScale, and
UltraScale+ device data occupies 79 GiB after installer cleanup. Use a 200 GiB
Volume initially so a replacement release and rollback can coexist. The CX33
(4 shared vCPUs, 8 GiB RAM) is the initial one-job-at-a-time production shape;
resize only if measured designs need more memory or lower latency. The normal
application image remains small and contains no AMD payload; expanding the app
root disk is not required for this layout.

## Licensing boundary for production

Vivado 2026.1 BASIC is a free annual node-locked license, not freely
redistributable software. The application image and GHCR workflow must never
contain the installer, installed Vivado tree, AMD account token, or license.

The checked-in overlay is a packaging primitive for local use or a dedicated,
properly licensed worker. It is not authorization to offer public multi-tenant
Vivado synthesis. The production integration therefore permits only the named
license owner to invoke Vivado; public users receive Yosys. A future public
Vivado path should use a customer-side runner/import model or wait for written
AMD authorization for hosted use.

Current AMD references:

- [Vivado licensing tiers and BASIC license](https://www.amd.com/en/products/software/adaptive-socs-and-fpgas/vivado/vivado-buy.html)
- [Device availability by subscription tier](https://docs.amd.com/r/en-US/ug973-vivado-release-notes-install-license/Device-Availability-by-Subscription-Tier)
- [Create a node-locked license](https://docs.amd.com/r/en-US/ug973-vivado-release-notes-install-license/Create-and-Generate-a-License-Key-File)
- [Vivado 2026.1 EULA](https://download.amd.com/docnav/documents/eula/ug1593_vivado_eulas_2026.1.pdf)
