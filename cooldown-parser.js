(function attachCooldownParser(root, factory) {
  const parser = factory();
  if (typeof module === 'object' && module.exports) module.exports = parser;
  if (root) root.CooldownParser = parser;
})(typeof globalThis !== 'undefined' ? globalThis : null, function createCooldownParser() {
  function normalizeCooldownText(rawText) {
    return String(rawText || '')
      .replace(/[：]/g, ':')
      .replace(/[|Il]/g, '1')
      .replace(/[OoD]/g, '0')
      .replace(/[Ss]/g, '5')
      .replace(/[ＢB]/g, '8');
  }

  function toTotalSeconds(minutes, seconds, maxSeconds) {
    const parsedMinutes = parseInt(minutes, 10);
    const parsedSeconds = seconds === undefined || seconds === '' ? 0 : parseInt(seconds, 10);
    if (!Number.isFinite(parsedMinutes) || !Number.isFinite(parsedSeconds)) return null;
    if (parsedMinutes < 0 || parsedSeconds < 0 || parsedSeconds >= 60) return null;

    const total = parsedMinutes * 60 + parsedSeconds;
    return total > 0 && total <= maxSeconds ? total : null;
  }

  function parseCooldownText(rawText, maxSeconds) {
    const limit = parseInt(maxSeconds, 10);
    if (!Number.isFinite(limit) || limit <= 0) return null;

    const normalized = normalizeCooldownText(rawText);
    const compact = normalized.replace(/\s/g, '');

    const unitTimeMatch = compact.match(/(\d{1,2})(?:분|m|min)(?:(\d{1,2})(?:초|s|sec)?)?/i);
    if (unitTimeMatch) {
      const total = toTotalSeconds(unitTimeMatch[1], unitTimeMatch[2], limit);
      if (total !== null) return total;
      return null;
    }

    const secondsUnitMatch = compact.match(/(\d{1,4})(?:초|s|sec)/i);
    if (secondsUnitMatch) {
      const seconds = parseInt(secondsUnitMatch[1], 10);
      if (Number.isFinite(seconds) && seconds > 0 && seconds <= limit) return seconds;
    }

    const separatedTimeMatch = compact.match(/(\d{1,2})\D+(\d{1,2})/);
    if (separatedTimeMatch) {
      const total = toTotalSeconds(separatedTimeMatch[1], separatedTimeMatch[2], limit);
      if (total !== null) return total;
      return null;
    }

    const digitGroups = compact.match(/\d{1,4}/g);
    if (!digitGroups) return null;

    const parsed = [];
    for (const group of digitGroups) {
      if (group.length >= 3) {
        const minutes = group.slice(0, -2);
        const seconds = group.slice(-2);
        const total = toTotalSeconds(minutes, seconds, limit);
        if (total !== null) parsed.push({ value: total, priority: 2 });
      }

      const seconds = parseInt(group, 10);
      if (Number.isFinite(seconds) && seconds > 0 && seconds <= limit) {
        parsed.push({ value: seconds, priority: group.length >= 3 ? 1 : 3 });
      }
    }

    if (parsed.length === 0) return null;
    parsed.sort((a, b) => b.priority - a.priority || String(b.value).length - String(a.value).length || b.value - a.value);
    return parsed[0].value;
  }

  function shouldConfirmInitialRead(seconds, maxSeconds) {
    const parsedSeconds = parseInt(seconds, 10);
    const parsedMaxSeconds = parseInt(maxSeconds, 10);
    if (!Number.isFinite(parsedSeconds) || !Number.isFinite(parsedMaxSeconds)) return false;
    const smallReadThreshold = Math.max(5, Math.ceil(parsedMaxSeconds * 0.1));
    return parsedSeconds > smallReadThreshold;
  }

  return {
    normalizeCooldownText,
    parseCooldownText,
    shouldConfirmInitialRead,
  };
});
