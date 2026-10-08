# Native dependency patches

`prebuild-install@7.1.3` uses the deprecated top-level `fs.R_OK` and `fs.W_OK`
aliases. Use `fs.constants` so SQLite installation works without deprecated
Node APIs. Remove when the dependency ships this fix.

`@discordjs/opus@0.10.0` accidentally concatenates two preprocessor definitions
in `binding.gyp`. Split `POSIX` and `__STDC_FORMAT_MACROS` into separate entries.
Its bundled Opus also flattens two coefficient rows through a pointer to the
first row. Backport the pointer signatures from [current Opus](https://github.com/xiph/opus/blob/main/silk/main.h),
including matching platform declarations. Storage, indexing, and codec behavior
stay unchanged; GCC can no longer mistake the first row for the entire input.
Remove when the package updates its build definitions and bundled Opus.

pnpm applies these version-specific patches during installation. Docker copies
this directory before installing dependencies. Keep compiler warnings enabled.

The virtual store path limit is 60 characters. pnpm then hashes patched package
paths before their `patch_hash=` suffix; an unescaped `=` in the native addon
output path breaks node-gyp generated Makefile targets.
