{
  "targets": [
    {
      "target_name": "ndi_sender",
      "sources": [ "native/ndi_sender.cc" ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "defines": [ "NAPI_CPP_EXCEPTIONS" ],
      "conditions": [
        [ "OS=='win'", {
          "include_dirs": [
            "<!(node scripts/ndi-sdk-dir.js include)"
          ],
          "libraries": [
            "<!(node scripts/ndi-sdk-dir.js lib)"
          ],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "AdditionalOptions": [ "/EHsc", "/std:c++17" ]
            }
          }
        } ]
      ]
    }
  ]
}
