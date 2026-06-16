NDI 6 SDK — encrypted blob
==========================

The NDI SDK license does not allow republishing the SDK in a public repo. The dependencies are instead pushed as a AES-256-GCM encrypted blob:

CI decrypts it at build time with a passphrase stored as the GitHub secret NDI_SDK_KEY. The decrypted files land in vendor/ndi/ which is git-ignored and never committed.

------------------------------------------------------------------------------
1) Prepare a source folder with the SDK files in this exact layout
------------------------------------------------------------------------------

    <sourceDir>/
      Include/Processing.NDI.Lib.h        (+ the other headers)
      Lib/x64/Processing.NDI.Lib.x64.lib
      Bin/x64/Processing.NDI.Lib.x64.dll

From an installed SDK (default C:\Program Files\NDI\NDI 6 SDK), in PowerShell:

    $src   = "C:\Program Files\NDI\NDI 6 SDK"
    $stage = ".\ndi-stage"
    New-Item -ItemType Directory "$stage\Lib\x64","$stage\Bin\x64" -Force | Out-Null
    Copy-Item "$src\Include"                          "$stage\Include" -Recurse
    Copy-Item "$src\Lib\x64\Processing.NDI.Lib.x64.lib" "$stage\Lib\x64"
    Copy-Item "$src\Bin\x64\Processing.NDI.Lib.x64.dll" "$stage\Bin\x64"

------------------------------------------------------------------------------
2) Encrypt it into the committed blob
------------------------------------------------------------------------------

    $env:NDI_SDK_KEY = "choose-a-strong-passphrase"
    node scripts/crypt-ndi.js encrypt .\ndi-stage vendor/ndi-sdk.enc

    git add vendor/ndi-sdk.enc
    git commit -m "Add encrypted NDI SDK"

------------------------------------------------------------------------------
3) Add the passphrase as a GitHub Actions secret
------------------------------------------------------------------------------

    Repo Settings -> Secrets and variables -> Actions -> New repository secret
      Name:  NDI_SDK_KEY
      Value: the same passphrase you used above

The workflow then decrypts vendor/ndi-sdk.enc before building. No SDK download
and no usable SDK is ever exposed publicly.

------------------------------------------------------------------------------
4) Build locally (optional)
------------------------------------------------------------------------------

    $env:NDI_SDK_KEY = "your-passphrase"
    node scripts/crypt-ndi.js decrypt vendor/ndi-sdk.enc vendor/ndi
    npm run build:native     # or npm run dist

License note: keep this SDK copy under your own NDI SDK license agreement.
NDI(R) is a registered trademark of Vizrt NDI AB.
