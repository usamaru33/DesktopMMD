import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: [
        'src/main/llm/**', 'src/main/tools/**', 'src/main/character/**', 'src/main/memory/**', 'src/main/proactive/**',
        'src/main/speech/voiceTuning.ts', 'src/main/speech/ttsNormalize.ts', 'src/renderer/character/lipsync.ts',
        'src/renderer/character/character/morphs.ts', 'src/renderer/character/character/motion.ts',
      ],
      exclude: ['src/main/llm/FakeLlm.ts'],
    },
  },
});
