#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
图像全景拼接脚本

功能：将两张有重叠区域的图片拼接为一张全景图。
方法：使用SIFT特征检测、KNN匹配、RANSAC估计单应性矩阵、透视变换与加权融合。
依赖：opencv-python (cv2), numpy, matplotlib
"""

import cv2
import numpy as np
import matplotlib.pyplot as plt
import sys
from my_ransac import ransac_homography

def main():
    # 两张图片的路径（请根据实际情况修改）
    img_path_left = "../img_left.jpg"
    img_path_right = "../img_right.jpg"
    
    # 读取图片并检查
    img_left = cv2.imread(img_path_left)
    img_right = cv2.imread(img_path_right)
    if img_left is None:
        print(f"错误：无法读取左侧图片 '{img_path_left}'，请检查路径。")
        sys.exit(1)
    if img_right is None:
        print(f"错误：无法读取右侧图片 '{img_path_right}'，请检查路径。")
        sys.exit(1)
    print(f"成功读取左侧图片：{img_path_left}，尺寸：{img_left.shape[1]}x{img_left.shape[0]}")
    print(f"成功读取右侧图片：{img_path_right}，尺寸：{img_right.shape[1]}x{img_right.shape[0]}")
    
    # 转换为RGB用于显示
    img_left_rgb = cv2.cvtColor(img_left, cv2.COLOR_BGR2RGB)
    img_right_rgb = cv2.cvtColor(img_right, cv2.COLOR_BGR2RGB)
    
    # ---------- 步骤1：特征提取 ----------
    print("\n正在提取SIFT特征...")
    sift = cv2.SIFT_create()
    kp_left, des_left = sift.detectAndCompute(img_left, None)
    kp_right, des_right = sift.detectAndCompute(img_right, None)
    print(f"左侧图片检测到 {len(kp_left)} 个特征点")
    print(f"右侧图片检测到 {len(kp_right)} 个特征点")
    
    # ---------- 步骤2：特征匹配（BFMatcher + KNN） ----------
    print("\n正在匹配特征点...")
    bf = cv2.BFMatcher(cv2.NORM_L2, crossCheck=False)
    matches = bf.knnMatch(des_left, des_right, k=2)
    
    # Lowe's比率测试，过滤低质量匹配
    good_matches = []
    for m, n in matches:
        if m.distance < 0.75 * n.distance:
            good_matches.append(m)
    print(f"初始匹配对数量：{len(good_matches)}")
    
    # ---------- 步骤3：RANSAC估计单应性矩阵 ----------
    """
    RANSAC（随机采样一致性）的作用：
    从包含错误匹配（外点）的匹配点集中，通过迭代随机采样4对匹配点计算单应性矩阵，
    并统计满足该矩阵的内点数量，最终选择内点最多的矩阵作为最优估计。
    这能有效剔除误匹配，提高变换矩阵的鲁棒性。
    
    单应性矩阵（Homography Matrix）的数学意义：
    是一个3x3的矩阵，描述了两个平面之间的透视变换关系。
    对于图像拼接，它将一张图像上的点映射到另一张图像对应的点上。
    其形式为：
    [h11 h12 h13]
    [h21 h22 h23]
    [h31 h32 h33]（通常归一化使h33=1）
    变换关系：x' = (h11*x + h12*y + h13) / (h31*x + h32*y + 1)
              y' = (h21*x + h22*y + h23) / (h31*x + h32*y + 1)
    """
    print("\n正在通过RANSAC计算单应性矩阵...")
    if len(good_matches) < 4:
        print("匹配点数量不足（<4），无法计算单应性矩阵。")
        sys.exit(1)
    
    src_pts = np.float32([kp_left[m.queryIdx].pt for m in good_matches]).reshape(-1, 1, 2)
    dst_pts = np.float32([kp_right[m.trainIdx].pt for m in good_matches]).reshape(-1, 1, 2)
    
    # 使用手写的RANSAC实现
    H, mask = ransac_homography(src_pts, dst_pts, threshold=5.0)
    inliers = np.sum(mask)
    print(f"RANSAC过滤后内点数量：{inliers} / {len(good_matches)}")
    
    if H is None:
        print("单应性矩阵计算失败。")
        sys.exit(1)
    
    # ---------- 步骤4：透视变换与画布构建 ----------
    print("\n正在执行透视变换...")
    h_left, w_left = img_left.shape[:2]
    h_right, w_right = img_right.shape[:2]
    
    # 获取左侧图片四个角点
    corners_left = np.float32([[0, 0], [w_left, 0], [w_left, h_left], [0, h_left]]).reshape(-1, 1, 2)
    # 将左侧图片角点变换到右侧图片坐标系
    corners_left_trans = cv2.perspectiveTransform(corners_left, H)
    
    # 合并右侧图片角点和变换后的左侧角点，计算新画布边界
    corners_right = np.float32([[0, 0], [w_right, 0], [w_right, h_right], [0, h_right]]).reshape(-1, 1, 2)
    corners_combined = np.concatenate((corners_right, corners_left_trans), axis=0)
    
    # 计算最小包围盒
    [x_min, y_min] = np.int32(corners_combined.min(axis=0).ravel() - 0.5)
    [x_max, y_max] = np.int32(corners_combined.max(axis=0).ravel() + 0.5)
    
    # 变换矩阵平移量
    H_translation = np.array([[1, 0, -x_min], [0, 1, -y_min], [0, 0, 1]])
    
    # 对左侧图片进行透视变换，并平移到新画布
    warped_left = cv2.warpPerspective(img_left, H_translation @ H, (x_max - x_min, y_max - y_min))
    
    # 将右侧图片直接放到新画布对应位置
    canvas = np.zeros((y_max - y_min, x_max - x_min, 3), dtype=np.uint8)
    canvas[-y_min:-y_min + h_right, -x_min:-x_min + w_right] = img_right
    
    # ---------- 步骤5：加权融合（消除接缝） ----------
    """
    加权融合算法原理：
    在重叠区域，根据每个像素到各自图像非重叠边界的距离分配权重。
    距离边界越近的像素，其对应图像的权重越大，
    这样从一张图过渡到另一张图时，权重平滑变化，消除明显接缝。
    具体实现：对重叠区域计算左右图像的alpha值，
    alpha = 左侧图像到其左侧边界的距离 / 重叠区域总宽度，
    然后像素值 = alpha * 左侧像素 + (1-alpha) * 右侧像素。
    """
    print("\n正在执行加权融合...")
    # 确定重叠区域（canvas中非零像素对应的warpped_left非零像素的区域）
    mask_left = (warped_left > 0).astype(np.float32)
    mask_right = (canvas > 0).astype(np.float32)
    overlap = mask_left * mask_right
    
    # 如果存在重叠区域
    if np.any(overlap):
        # 计算每列左侧alpha值（从左到右线性增加）
        # 先找出每一列中重叠的行的范围
        gray_overlap = cv2.cvtColor((overlap * 255).astype(np.uint8), cv2.COLOR_BGR2GRAY)
        # 对于每一列，找到重叠区域的最小和最大行索引
        ys, xs = np.where(gray_overlap > 0)
        if len(ys) > 0:
            for x in range(x_max - x_min):
                col_mask = gray_overlap[:, x] > 0
                y_indices = np.where(col_mask)[0]
                if len(y_indices) > 0:
                    y_min_overlap = y_indices.min()
                    y_max_overlap = y_indices.max()
                    # 对该列重叠区域创建线性渐变alpha
                    alpha = np.linspace(1, 0, y_max_overlap - y_min_overlap + 1)
                    alpha = np.tile(alpha, (3, 1)).T  # 扩展到三通道
                    # 混合
                    canvas[y_min_overlap:y_max_overlap+1, x, :] = (
                        alpha * warped_left[y_min_overlap:y_max_overlap+1, x, :].astype(np.float32) +
                        (1 - alpha) * canvas[y_min_overlap:y_max_overlap+1, x, :].astype(np.float32)
                    ).astype(np.uint8)
    
    # 将未被覆盖的左侧图区域复制到canvas
    mask_left_only = (mask_left > 0) & (mask_right == 0)
    canvas = np.where(mask_left_only > 0, warped_left, canvas)
    
    # ---------- 结果展示 ----------
    print("\n拼接完成！")
    canvas_rgb = cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB)
    plt.figure(figsize=(12, 6))
    plt.subplot(1, 2, 1)
    plt.imshow(img_left_rgb)
    plt.title("左侧图片")
    plt.subplot(1, 2, 2)
    plt.imshow(img_right_rgb)
    plt.title("右侧图片")
    plt.figure(figsize=(12, 6))
    plt.imshow(canvas_rgb)
    plt.title("拼接结果")
    plt.axis('off')
    plt.show()
    
if __name__ == "__main__":
    main()
