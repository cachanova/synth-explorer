# syntax=docker/dockerfile:1.7

FROM --platform=linux/amd64 node:24.11.1-bookworm-slim@sha256:48abc13a19400ca3985071e287bd405a1d99306770eb81d61202fb6b65cf0b57 AS web-builder
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --ignore-scripts
COPY web/ ./
RUN npm run build

FROM --platform=linux/amd64 rust:1.97.0-bookworm@sha256:7d0723df719e7f213b69dc7c8c595985c3f4b060cfbee4f7bc0e347a86fe3b6a AS server-builder
WORKDIR /build/server
COPY server/Cargo.toml server/Cargo.lock ./
COPY server/src ./src
RUN cargo build --locked --release --jobs 4 \
    && strip target/release/synth-explorer-server

FROM --platform=linux/amd64 ubuntu:24.04@sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90 AS yosys-builder
ARG DEBIAN_FRONTEND=noninteractive
ARG YOSYS_VERSION=0.67
ARG YOSYS_SHA256=608d758a6efc73c9f866b0a822aa2f788c2889fcb70dcdcc0e758009465049f6
ARG YOSYS_BUILD_JOBS=2
RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        bison \
        build-essential \
        ca-certificates \
        cmake \
        curl \
        flex \
        gawk \
        lld \
        ninja-build \
        pkg-config \
        python3 \
        zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build/yosys
# The service uses the built-in read_verilog frontend and synthesis passes;
# interactive, FFI, and optional read_slang support are outside its runtime API.
RUN curl --fail --location --silent --show-error --retry 3 \
        --output yosys.tar.gz \
        "https://github.com/YosysHQ/yosys/releases/download/v${YOSYS_VERSION}/yosys.tar.gz" \
    && echo "${YOSYS_SHA256}  yosys.tar.gz" | sha256sum --check --strict \
    && tar --extract --gzip --file yosys.tar.gz --strip-components=0 \
    && rm yosys.tar.gz \
    && cmake -S . -B build -G Ninja \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX=/opt/yosys \
        -DCMAKE_EXE_LINKER_FLAGS=-fuse-ld=lld \
        -DCMAKE_SHARED_LINKER_FLAGS=-fuse-ld=lld \
        -DYOSYS_WITHOUT_LIBFFI=ON \
        -DYOSYS_WITHOUT_SLANG=ON \
        -DYOSYS_WITHOUT_TCL=ON \
        -DYOSYS_WITHOUT_READLINE=ON \
        -DYOSYS_WITHOUT_EDITLINE=ON \
    && cmake --build build --parallel "${YOSYS_BUILD_JOBS}" \
    && cmake --install build --strip \
    && /opt/yosys/bin/yosys -V | grep -F "Yosys ${YOSYS_VERSION}" \
    && test -x /opt/yosys/bin/yosys-abc \
    && cd / \
    && rm -rf /build/yosys
WORKDIR /
RUN /opt/yosys/bin/yosys-abc -c quit

FROM --platform=linux/amd64 ubuntu:24.04@sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90 AS runtime
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        ca-certificates \
        curl \
        libstdc++6 \
        zlib1g \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 synth-explorer \
    && useradd --uid 10001 --gid synth-explorer --no-create-home \
        --home-dir /nonexistent --shell /usr/sbin/nologin synth-explorer

WORKDIR /app
COPY --from=yosys-builder /opt/yosys /opt/yosys
COPY --from=server-builder /build/server/target/release/synth-explorer-server /usr/local/bin/synth-explorer-server
COPY --from=web-builder /build/web/dist ./web/dist
COPY examples ./examples

ARG BUILD_COMMIT=unknown
LABEL org.opencontainers.image.title="Synth Explorer" \
      org.opencontainers.image.description="Browser-based structural RTL synthesis explorer" \
      org.opencontainers.image.source="https://github.com/cachanova/synth-explorer" \
      org.opencontainers.image.revision="${BUILD_COMMIT}"

ENV PATH="/opt/yosys/bin:${PATH}" \
    STATIC_DIR=/app/web/dist \
    EXAMPLES_DIR=/app/examples \
    BIND_ADDR=0.0.0.0:8787 \
    BUILD_COMMIT=${BUILD_COMMIT}

USER 10001:10001
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["curl", "--fail", "--silent", "--show-error", "http://127.0.0.1:8787/healthz"]
ENTRYPOINT ["/usr/local/bin/synth-explorer-server"]
