# サードパーティ製ライブラリ

Kakehashi に同梱する外部ライブラリの一覧です。

## 1. paperkey

- **パス**: `vendor/paperkey/`
- **バージョン**: 1.6 (https://github.com/dmshaw/paperkey)
- **ライセンス**: GNU General Public License v2+ (GPL v2+)
- **ライセンスファイル**: `vendor/paperkey/COPYING`
- **用途**: OpenPGP 秘密鍵の再構成（WASM ビルドで使用）
- **ビルド手順**:
  ```
  # Emscripten SDK のインストール（初回のみ）
  git clone https://github.com/emscripten-core/emsdk.git ~/emsdk
  cd ~/emsdk
  ./emsdk install latest
  ./emsdk activate latest
  source ./emsdk_env.sh

  # paperkey の WASM ビルド
  cd vendor/paperkey/
  ~/emsdk/upstream/emscripten/emcc -O2 --no-entry \
    -sEXPORTED_FUNCTIONS='["_restore","_fopen","_fclose","_fflush","_malloc","_free"]' \
    -sEXPORTED_RUNTIME_METHODS='["ccall","cwrap","FS","HEAPU8","getValue","setValue","UTF8ToString","stringToUTF8","lengthBytesUTF8"]' \
    -sALLOW_MEMORY_GROWTH=1 -sFILESYSTEM=1 \
    -sINCOMING_MODULE_JS_API='["print","printErr","locateFile","onRuntimeInitialized"]' \
    -o paperkey.js restore.c packets.c parse.c output.c sha1.c paperkey.c -I.
  ```
- **追加ファイル**:
  - `config.h`: Emscripten ビルド用スタブヘッダ（オリジナルには含まれない）
  - `sha1.h`, `sha1.c`: SHA-1 実装（パケットフィンガープリント計算用、オリジナルには含まれない）
- **注意**: GPL v2+ ライセンスのため、Kakehashi 本体を GPL 互換でないライセンスで配布する場合はライセンス上の影響を確認する必要があります。

## 2. jsQR

- **パス**: `vendor/jsqr/jsqr.js`
- **バージョン**: 1.4.0 (https://github.com/cozmo/jsQR)
- **ライセンス**: MIT License
- **用途**: QR コードデコード（復元ページで使用）
- **同梱ファイル**: `jsqr.js` のみ（`jsqr.min.js` は同梱しない）

## 3. ライセンス

Kakehashi 本体は GNU General Public License v2+ (GPL v2+) でライセンスされています。
詳細は `LICENSE` ファイルを参照してください。

paperkey も GPL v2+ で、Kakehashi 本体と同じライセンス体系の下で配布されています。