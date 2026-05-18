//! geartoon データの暗号化・復号・スクランブルを担当するモジュール。
//!
//! ## 設計方針
//! - カジュアルな転用防止が目的。完全な保護ではない。
//! - デスクトップアプリとビューアアプリで同じ鍵・アルゴリズムを使用。
//! - gear_db: AES-256-GCM（nonce はファイル先頭12バイト）
//! - 画像: 固定XORキーでバイト列をスクランブル

use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use aes_gcm::aead::rand_core::RngCore;

// デスクトップ・ビューア共通の鍵（32バイト = AES-256）
// ビューアアプリにもこの定数をそのままコピーすること
const DB_KEY: &[u8; 32] = b"geartoon-gear-db-key-2025-v1!!!!";

// 画像スクランブル用XORキー（1バイト）
const IMG_XOR: u8 = 0x5A;

/// gear_db の JSON バイト列を AES-256-GCM で暗号化する。
/// 出力形式: [nonce(12バイト)][ciphertext]
pub fn encrypt_db(plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(DB_KEY)
        .map_err(|e| format!("cipher init failed: {e}"))?;

    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| format!("encrypt failed: {e}"))?;

    let mut out = Vec::with_capacity(12 + ciphertext.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// gear_db.bin の暗号化バイト列を復号して JSON バイト列を返す。
pub fn decrypt_db(data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() < 12 {
        return Err("invalid gear_db.bin: too short".to_string());
    }
    let (nonce_bytes, ciphertext) = data.split_at(12);
    let cipher = Aes256Gcm::new_from_slice(DB_KEY)
        .map_err(|e| format!("cipher init failed: {e}"))?;
    let nonce = Nonce::from_slice(nonce_bytes);

    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| "gear_db.bin の復号に失敗しました（データ破損または鍵不一致）".to_string())
}

/// PNG バイト列を XOR スクランブルして .gti 形式で返す。
/// 復元も同じ関数で行える（XOR の対称性）。
pub fn scramble_image(data: &[u8]) -> Vec<u8> {
    data.iter().map(|b| b ^ IMG_XOR).collect()
}
