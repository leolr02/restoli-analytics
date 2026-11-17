# AGENTS.md — Restoli Analytics

## Alcance del proyecto

- El proyecto activo es `restoli_analytics`, ubicado en `C:\Users\leolr\WebstormProjects\restoli_analytics`.
- Antes de ejecutar cualquier prompt o realizar cualquier cambio en este proyecto, consulta este archivo y respeta sus reglas.
- El proyecto `inware` (`D:\Apache24\htdocs\inware`) es únicamente una referencia funcional y visual.
- No modificar, crear ni eliminar archivos dentro de `inware` como parte del trabajo de `restoli_analytics`, salvo que el usuario lo solicite explícitamente.
- Mantener todos los cambios, comandos y validaciones enfocados en `restoli_analytics`.

## Gestor de paquetes y comandos

- Para este proyecto se usará exclusivamente `npx` como herramienta del ecosistema Node.js.
- No usar `npm`, `yarn`, `pnpm` ni `bun` para instalar dependencias, ejecutar scripts o modificar el lockfile.
- Antes de ejecutar un comando de Node.js, comprobar que sea compatible con esta regla y preferir `npx` cuando corresponda.
- No cambiar de gestor de paquetes ni generar un lockfile de otro gestor sin autorización explícita del usuario.

## Forma de trabajo

- Revisar primero la estructura y el código existente antes de implementar cambios.
- Preservar los cambios existentes del usuario y modificar únicamente lo necesario para la tarea solicitada.
- Seguir las convenciones, dependencias y arquitectura ya establecidas en `restoli_analytics`.
- Usar `inware` solo para consultar patrones o comportamiento de referencia; adaptar el resultado a la arquitectura de `restoli_analytics`.

## Prioridad de instrucciones

1. Instrucciones directas del usuario.
2. Este `AGENTS.md`.
3. Convenciones y documentación del propio proyecto.
4. Convenciones generales del agente.
5. Usa siempre UTF-8 para códificar o actualizar archivos.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
