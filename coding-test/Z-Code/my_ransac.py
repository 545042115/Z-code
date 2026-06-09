#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
手写 RANSAC 算法实现单应性矩阵估计
"""

import numpy as np

def compute_homography_dlt(src_pts, dst_pts):
    """
    使用直接线性变换 (DLT) 计算单应性矩阵
    src_pts, dst_pts: 形状为 (4, 2) 的数组
    返回 3x3 的矩阵 H
    """
    A = []
    for i in range(4):
        x, y = src_pts[i]
        xp, yp = dst_pts[i]
        A.append([-x, -y, -1, 0, 0, 0, x * xp, y * xp, xp])
        A.append([0, 0, 0, -x, -y, -1, x * yp, y * yp, yp])
    A = np.array(A)
    U, S, Vt = np.linalg.svd(A)
    H = Vt[-1].reshape(3, 3)
    H = H / H[2, 2]
    return H

def compute_projection_error(pt_src, pt_dst, H):
    p = np.array([pt_src[0], pt_src[1], 1.0])
    q = np.array([pt_dst[0], pt_dst[1], 1.0])
    Hp = H @ p
    Hp = Hp / Hp[2]
    q_inv = np.linalg.inv(H) @ q
    q_inv = q_inv / q_inv[2]
    error = np.linalg.norm(Hp[:2] - pt_dst) + np.linalg.norm(q_inv[:2] - pt_src)
    return error

def ransac_homography(src_pts, dst_pts, threshold=5.0, max_iters=2000, inlier_ratio=0.5):
    if src_pts.ndim == 3 and src_pts.shape[1] == 1 and src_pts.shape[2] == 2:
        src_pts = src_pts.reshape(-1, 2)
    if dst_pts.ndim == 3 and dst_pts.shape[1] == 1 and dst_pts.shape[2] == 2:
        dst_pts = dst_pts.reshape(-1, 2)
    N = src_pts.shape[0]
    if N < 4:
        return None, np.zeros((N, 1), dtype=np.uint8)
    best_H = None
    best_inlier_count = -1
    best_mask = np.zeros((N, 1), dtype=np.uint8)
    for _ in range(max_iters):
        indices = np.random.choice(N, 4, replace=False)
        src_sample = src_pts[indices]
        dst_sample = dst_pts[indices]
        H = compute_homography_dlt(src_sample, dst_sample)
        errors = np.array([compute_projection_error(src_pts[i], dst_pts[i], H) for i in range(N)])
        inlier_mask = errors < threshold
        inlier_count = np.sum(inlier_mask)
        if inlier_count > best_inlier_count:
            best_inlier_count = inlier_count
            best_H = H
            best_mask = inlier_mask.astype(np.uint8).reshape(-1, 1)
        if inlier_count >= N * inlier_ratio:
            break
    return best_H, best_mask
