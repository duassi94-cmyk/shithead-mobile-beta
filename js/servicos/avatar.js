// Módulo ES (sem etapa de build): importa só com caminho relativo, sem import map,
// para funcionar no Safari do iOS 15.4+. Veja js/ponte.js.

import { AppConfig } from '../config.js';

/* ==========================================================================
   2. MÓDULO DE AVATARES E PROCESSAMENTO DE IMAGEM (AvatarModule)
   ========================================================================== */
const AvatarModule = (() => {
  const svgToDataUrl = (svgStr) => 'data:image/svg+xml;utf8,' + encodeURIComponent(svgStr.trim());

  const DEFAULT_AVATARS = {
    human: svgToDataUrl(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <rect width="100" height="100" rx="50" fill="#0f766e"/>
        <circle cx="50" cy="36" r="18" fill="#f8fafc"/>
        <path d="M18 88 C18 62, 82 62, 82 88 Z" fill="#f8fafc"/>
      </svg>`),
    easy: svgToDataUrl(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <rect width="100" height="100" rx="50" fill="#b45309"/>
        <ellipse cx="50" cy="24" rx="36" ry="10" fill="#fde047"/>
        <rect x="30" y="10" width="40" height="14" rx="6" fill="#eab308"/>
        <circle cx="50" cy="54" r="24" fill="#fed7aa"/>
        <circle cx="41" cy="50" r="3.5" fill="#1e293b"/>
        <circle cx="59" cy="50" r="3.5" fill="#1e293b"/>
        <path d="M38 66 Q50 76 62 66" stroke="#fff" stroke-width="5" fill="none" stroke-linecap="round"/>
      </svg>`),
    medium: svgToDataUrl(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <rect width="100" height="100" rx="50" fill="#6d28d9"/>
        <path d="M20 55 C20 20, 80 20, 80 55 L85 85 L15 85 Z" fill="#4c1d95"/>
        <circle cx="50" cy="52" r="23" fill="#fbcfe8"/>
        <rect x="28" y="41" width="19" height="11" rx="5" fill="#0f172a" stroke="#f59e0b" stroke-width="2"/>
        <rect x="53" y="41" width="19" height="11" rx="5" fill="#0f172a" stroke="#f59e0b" stroke-width="2"/>
        <line x1="47" y1="46" x2="53" y2="46" stroke="#f59e0b" stroke-width="2"/>
        <path d="M43 64 Q50 69 57 64" stroke="#be123c" stroke-width="3.5" fill="none" stroke-linecap="round"/>
      </svg>`),
    hard: svgToDataUrl(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <rect width="100" height="100" rx="50" fill="#111827"/>
        <circle cx="50" cy="50" r="32" fill="#374151" stroke="#ef4444" stroke-width="3"/>
        <rect x="26" y="38" width="48" height="13" rx="6" fill="#ef4444"/>
        <circle cx="40" cy="44.5" r="3" fill="#fef08a"/>
        <circle cx="60" cy="44.5" r="3" fill="#fef08a"/>
        <path d="M36 66 L44 62 L50 67 L56 62 L64 66" stroke="#9ca3af" stroke-width="3" fill="none"/>
      </svg>`)
  };

  function getDefaultAvatar(type, persona) {
    if (type === 'bot' && persona && DEFAULT_AVATARS[persona]) {
      return DEFAULT_AVATARS[persona];
    }
    return DEFAULT_AVATARS.human;
  }

  // Recorta o centro em quadrado e reduz para 96x96 (JPEG leve, ~3-5 KB)
  function drawableToAvatar(source, srcW, srcH, mirror = false) {
    const size = AppConfig.AVATAR_SIZE;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const minDim = Math.min(srcW, srcH);
    const sx = (srcW - minDim) / 2;
    const sy = (srcH - minDim) / 2;
    if (mirror) {
      ctx.translate(size, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(source, sx, sy, minDim, minDim, 0, 0, size, size);
    return canvas.toDataURL('image/jpeg', 0.75);
  }

  // Lê a imagem por URL temporária (bem mais leve na memória do que ler
  // o arquivo inteiro como texto: evita o navegador do celular travar/recarregar)
  function processImageFile(file, onSuccess, onError) {
    if (!file) return;
    const typeOk = !file.type || file.type.startsWith('image/');
    if (!typeOk) {
      onError('Formato inválido! Escolha uma foto (JPG, PNG ou WebP).');
      return;
    }
    if (file.size > AppConfig.MAX_IMAGE_BYTES) {
      onError('Arquivo muito grande! O limite é de 25 MB.');
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        onSuccess(drawableToAvatar(img, img.naturalWidth, img.naturalHeight));
      } catch (e) {
        onError('Não foi possível processar a imagem.');
      }
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      onError('Não foi possível ler a imagem (formato HEIC não é suportado; use JPG).');
    };
    img.src = url;
  }

  return { getDefaultAvatar, processImageFile, drawableToAvatar };
})();

export { AvatarModule };
