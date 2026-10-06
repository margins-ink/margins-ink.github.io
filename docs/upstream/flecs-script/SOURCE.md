# Flecs Script manual

- URL: https://raw.githubusercontent.com/SanderMertens/flecs/v4.1.2/docs/FlecsScript.md (rendered: https://www.flecs.dev/flecs/md_docs_2FlecsScript.html, which only redirects, so the markdown source is stored)
- Version: flecs v4.1.2 (the version vendored in world/vendor/flecs_ecs_sys), sha256 ae6df5cc02b6c3f3cfb296afceb42731a6512bd72fc11e090c3cfb196e9bde5b
- Fetched: 2026-10-06 UTC
- Licence: MIT (flecs repo LICENSE, "MIT License, Copyright (c) 2025 Sander Mertens", read)
- Question answered: can a Flecs script be re-run in place (hot reload), and what is cleaned up?
- Extracted (read, lines 1478-1506): "Managed scripts are scripts that are associated with an entity, and can be ran multiple times. Entities created by a managed script are tagged with the script. When script execution fails, the entities associated with the script will be deleted. Additionally, if after executing the script again an entity is no longer created by the script, it will also be deleted." Update with `ecs_script_update(world, s, 0, new_code)`. Unmanaged `ecs_script_run` failure does not delete what it created.
- Verified in the vendored C (world/vendor/flecs_ecs_sys/src/flecs.c `ecs_script_update`, ~line 64067): parse errors return before anything is deleted; eval errors delete all entities of the script (no rollback); `ecs_script_clear` = `ecs_delete_with((EcsScript, script))`.
