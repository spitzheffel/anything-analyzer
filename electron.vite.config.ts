import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const buildChannel = mode === 'internal' ? 'internal' : 'public'
  const outputRoot = buildChannel === 'internal' ? 'out-internal' : 'out'

  return {
    main: {
      define: {
        __AA_BUILD_CHANNEL__: JSON.stringify(buildChannel)
      },
      plugins: [externalizeDepsPlugin()],
      resolve: {
        alias: {
          '@shared': resolve('src/shared')
        }
      },
      build: {
        outDir: resolve(outputRoot, 'main')
      }
    },
    preload: {
      define: {
        __AA_BUILD_CHANNEL__: JSON.stringify(buildChannel)
      },
      plugins: [externalizeDepsPlugin()],
      resolve: {
        alias: {
          '@shared': resolve('src/shared')
        }
      },
      build: {
        outDir: resolve(outputRoot, 'preload'),
        rollupOptions: {
          input: {
            index: resolve('src/preload/index.ts'),
            'hook-script': resolve('src/preload/hook-script.ts'),
            'interaction-hook': resolve('src/preload/interaction-hook.ts'),
            'target-preload': resolve('src/preload/target-preload.ts'),
          }
        }
      }
    },
    renderer: {
      define: {
        __AA_BUILD_CHANNEL__: JSON.stringify(buildChannel)
      },
      resolve: {
        alias: {
          '@shared': resolve('src/shared')
        }
      },
      plugins: [react()],
      build: {
        outDir: resolve(outputRoot, 'renderer')
      }
    }
  }
})
