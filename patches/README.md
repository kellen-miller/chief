# Native dependency patches

`@discordjs/opus@0.10.0` accidentally concatenates two preprocessor definitions
in `binding.gyp`. Split `POSIX` and `__STDC_FORMAT_MACROS` into separate entries.
Its bundled Opus also flattens two coefficient rows through a pointer to the
first row. Backport the pointer signatures from [current Opus](https://github.com/xiph/opus/blob/main/silk/main.h),
including matching platform declarations. Storage, indexing, and codec behavior
stay unchanged; GCC can no longer mistake the first row for the entire input.
Remove the macro fix once [upstream PR #212](https://github.com/discordjs/opus/pull/212)
is released. The coefficient fix already exists in [Opus v1.5.2](https://github.com/xiph/opus/blob/v1.5.2/silk/main.h);
remove that backport once a released package includes those pointer signatures.

pnpm applies these version-specific patches during installation. Docker copies
this directory before installing dependencies. Keep compiler warnings enabled.

The virtual store path limit is 60 characters. pnpm then hashes patched package
paths before their `patch_hash=` suffix; an unescaped `=` in the native addon
output path breaks node-gyp generated Makefile targets.
