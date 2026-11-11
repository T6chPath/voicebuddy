#!/usr/bin/env bash
# Builds the on-phone picture maker: stable-diffusion.cpp's sd-cli for Android, with the NDK.
#
#   android/native/build-image-engine.sh <abi> <out-dir>      abi: arm64-v8a | x86_64
#
# Output (all named lib*.so so Android installs them next to the app's code, where the app may run them):
#   libsdcli.so            the sd-cli program itself (the app runs it as a separate process)
#   libggml*.so            the maths library; the CPU part comes in variants per chip generation
#                          (armv8.0 … armv9.2 / x86-64 levels) and the best one for the phone is picked at run time
#   libc++_shared.so       the C++ runtime shared by all of the above
set -euo pipefail

SD_REPO=https://github.com/leejet/stable-diffusion.cpp
SD_COMMIT=32d516c0197ed5ca31305b8575e14eb1451fad33      # master-1088 (2026-11-11)
ABI=${1:?abi}
OUT=${2:?out dir}
NDK=${ANDROID_NDK_LATEST_HOME:-${ANDROID_NDK_HOME:-${ANDROID_NDK:-}}}
[ -d "$NDK" ] || { echo "Android NDK not found (set ANDROID_NDK_HOME)"; exit 1; }
SRC=${SDCPP_SRC:-${RUNNER_TEMP:-/tmp}/sdcpp}

if [ ! -d "$SRC/.git" ]; then
  git init -q "$SRC"
  git -C "$SRC" remote add origin "$SD_REPO"
  git -C "$SRC" fetch -q --depth 1 origin "$SD_COMMIT"
  git -C "$SRC" checkout -q FETCH_HEAD
  git -C "$SRC" submodule update -q --init --depth 1 ggml
fi

case "$ABI" in
  arm64-v8a) TRIPLE=aarch64-linux-android ;;
  x86_64)    TRIPLE=x86_64-linux-android ;;
  *) echo "unsupported abi $ABI"; exit 1 ;;
esac

B="$SRC/build-$ABI"
cmake -S "$SRC" -B "$B" -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE="$NDK/build/cmake/android.toolchain.cmake" \
  -DANDROID_ABI="$ABI" -DANDROID_PLATFORM=android-24 -DANDROID_STL=c++_shared \
  -DCMAKE_BUILD_TYPE=Release \
  -DGGML_OPENMP=OFF -DGGML_NATIVE=OFF -DGGML_LLAMAFILE=ON \
  -DGGML_BACKEND_DL=ON -DGGML_CPU_ALL_VARIANTS=ON -DBUILD_SHARED_LIBS=ON \
  -DSD_WEBP=OFF -DSD_WEBM=OFF -DSD_BUILD_EXAMPLES=ON -DSD_BUILD_SHARED_LIBS=OFF -DSD_BUILD_SHARED_GGML_LIB=ON \
  -DCMAKE_C_FLAGS="-ffunction-sections -fdata-sections" -DCMAKE_CXX_FLAGS="-ffunction-sections -fdata-sections" \
  -DCMAKE_EXE_LINKER_FLAGS="-Wl,--gc-sections" -DCMAKE_SHARED_LINKER_FLAGS="-Wl,--gc-sections"
cmake --build "$B" --target sd-cli -j"$(nproc)"
# the CPU variants are loaded at run time, so they're separate targets
targets=$(ninja -C "$B" -t targets all | grep -oE '^ggml-cpu-[A-Za-z0-9_.]+:' | tr -d ':' | sort -u || true)
[ -n "$targets" ] && cmake --build "$B" --target $targets -j"$(nproc)"

mkdir -p "$OUT"
STRIP="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-strip"
cp "$B/bin/sd-cli" "$OUT/libsdcli.so"
find "$B" \( -name 'libggml*.so' -o -name 'libstable-diffusion*.so' \) -exec cp {} "$OUT/" \;
cp "$NDK/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/lib/$TRIPLE/libc++_shared.so" "$OUT/"
for f in "$OUT"/*.so; do "$STRIP" --strip-unneeded "$f"; done
echo "$SD_COMMIT" > "$OUT/../image-engine-$ABI.version"
ls -la "$OUT"
