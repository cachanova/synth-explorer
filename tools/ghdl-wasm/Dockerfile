FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    clang-16 \
    cmake \
    curl \
    file \
    git \
    gnat-13 \
    gprbuild \
    libclang-16-dev \
    libxml2 \
    llvm-16-dev \
    lld-16 \
    make \
    ninja-build \
    patch \
    python3 \
    tar \
    xz-utils \
    zlib1g-dev \
  && rm -rf /var/lib/apt/lists/*

ENV PATH=/usr/lib/llvm-16/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
