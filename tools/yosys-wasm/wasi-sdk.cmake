# WASI SDK toolchain for the project-owned Yosys module.
#
# SDK 33 still ships a compatibility toolchain that targets the deprecated
# wasm32-wasi alias. Use the current Preview 1 triple so Clang selects SDK 33's
# exception-enabled C++ runtime consistently.
if(NOT WASI_SDK_PREFIX)
  message(FATAL_ERROR "WASI_SDK_PREFIX must point to an unpacked WASI SDK")
endif()
set(WASI_SDK_PREFIX "${WASI_SDK_PREFIX}" CACHE PATH "Unpacked WASI SDK" FORCE)
list(APPEND CMAKE_TRY_COMPILE_PLATFORM_VARIABLES WASI_SDK_PREFIX)

list(APPEND CMAKE_MODULE_PATH "${WASI_SDK_PREFIX}/share/cmake")

set(CMAKE_SYSTEM_NAME WASI)
set(CMAKE_SYSTEM_VERSION 1)
set(CMAKE_SYSTEM_PROCESSOR wasm32)

set(CMAKE_C_COMPILER "${WASI_SDK_PREFIX}/bin/clang")
set(CMAKE_CXX_COMPILER "${WASI_SDK_PREFIX}/bin/clang++")
set(CMAKE_ASM_COMPILER "${WASI_SDK_PREFIX}/bin/clang")
set(CMAKE_AR "${WASI_SDK_PREFIX}/bin/llvm-ar")
set(CMAKE_RANLIB "${WASI_SDK_PREFIX}/bin/llvm-ranlib")
set(CMAKE_STRIP "${WASI_SDK_PREFIX}/bin/llvm-strip")

set(CMAKE_C_COMPILER_TARGET wasm32-wasip1)
set(CMAKE_CXX_COMPILER_TARGET wasm32-wasip1)
set(CMAKE_ASM_COMPILER_TARGET wasm32-wasip1)

set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
