// net/層が投げるエラー(err.code + err.params。net/archive-util.js の netError() 参照)を
// 利用者向けの文言に変換する。net/層はwasm/UIに依存しない素のモジュールという設計のため
// 文言を持たない。ここ(UI層)でui/i18n.jsの辞書を `net.error.<code>` キーで引く。

import { t } from './i18n.js';

/**
 * net/層で発生したエラー(または任意のError)を利用者向けの1行メッセージへ変換する。
 * @param {unknown} err
 * @returns {string}
 */
export function describeNetError(err) {
  if (err && typeof err === 'object' && typeof (/** @type {any} */ (err).code) === 'string') {
    const e = /** @type {{ code: string, params?: Record<string, string|number> }} */ (err);
    return t(`net.error.${e.code}`, e.params);
  }
  if (err instanceof Error && err.message) return err.message;
  return t('net.error.unknown');
}
