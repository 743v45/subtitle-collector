import { useCallback, useEffect, useState } from 'react';

export interface WhisperConfig {
  model: string;
  device: string;
  language: string;
  wordTimestamps: boolean;
}

const DEFAULT_CFG: WhisperConfig = {
  model: 'tiny',
  device: 'wasm',
  language: 'zh',
  wordTimestamps: false,
};

/** 自动提取开关(Phase 2 生效;Phase 1 仅存储)。读 storage,写发 SET_EXTRACT。 */
export function useExtract() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    chrome.storage.local.get('extractEnabled').then((r) => {
      setEnabled(r.extractEnabled === true);
    });
  }, []);
  const toggle = useCallback(async (v: boolean) => {
    setEnabled(v);
    await chrome.runtime.sendMessage({ type: 'SET_EXTRACT', enabled: v });
  }, []);
  return { enabled, toggle };
}

/** 模型参数。读 storage(bg 已 resolve 后的值),写发 SET_WHISPER_CONFIG。 */
export function useWhisperConfig() {
  const [config, setConfig] = useState<WhisperConfig>(DEFAULT_CFG);
  useEffect(() => {
    chrome.storage.local.get('whisperConfig').then((r) => {
      if (r.whisperConfig) setConfig({ ...DEFAULT_CFG, ...r.whisperConfig });
    });
  }, []);
  const update = useCallback((patch: Partial<WhisperConfig>) => {
    setConfig((c) => {
      const next = { ...c, ...patch };
      void chrome.runtime.sendMessage({
        type: 'SET_WHISPER_CONFIG',
        config: next,
      });
      return next;
    });
  }, []);
  return { config, update };
}
