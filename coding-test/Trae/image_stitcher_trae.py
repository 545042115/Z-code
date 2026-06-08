"""
图像全景拼接脚本 (Image Panorama Stitching)
==============================================
基于经典特征检测 + RANSAC + 透视变换 + 加权融合 的全手动实现。
完全不依赖任何深度学习框架。

依赖: opencv-python, numpy, matplotlib
安装: pip install opencv-python numpy matplotlib
"""

import cv2
import numpy as np
import matplotlib.pyplot as plt
from typing import Tuple, List, Optional


# ============================================================
# 1. 特征提取
# ============================================================
def detect_and_compute(image: np.ndarray) -> Tuple[List[cv2.KeyPoint], np.ndarray]:
    """
    使用 SIFT 检测关键点并计算 128 维描述子。

    SIFT (Scale-Invariant Feature Transform) 是一种尺度不变特征变换算法。
    它在不同尺度空间上检测极值点，并为每个关键点生成一个方向直方图描述子，
    对旋转、尺度缩放、亮度变化具有较好的不变性。

    参数:
        image: 输入图像 (BGR 格式)
    返回:
        keypoints: 关键点列表
        descriptors: 描述子数组，shape=(N, 128)
    """
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    sift = cv2.SIFT_create()
    keypoints, descriptors = sift.detectAndCompute(gray, None)
    return keypoints, descriptors


# ============================================================
# 2. 特征匹配
# ============================================================
def match_features(desc1: np.ndarray, desc2: np.ndarray,
                   ratio_thresh: float = 0.75) -> List[cv2.DMatch]:
    """
    使用 BFMatcher（暴力匹配器）+ KNN 对描述子进行匹配，
    并用 Lowe's ratio test 筛选高质量匹配对。

    Lowe's ratio test 原理:
        对于第一张图的每个特征点，在第二张图中找到最近邻和次近邻。
        如果最近邻距离 << 次近邻距离（比值 < threshold），
        说明这个匹配是"独一無二"的，可信度高；
        否则说明存在歧义，应当丢弃。

    参数:
        desc1, desc2: 两张图的描述子
        ratio_thresh: Lowe ratio 阈值（默认 0.75）
    返回:
        good_matches: 筛选后的高质量匹配对
    """
    bf = cv2.BFMatcher(cv2.NORM_L2)
    # KNN 匹配，k=2 返回最近邻和次近邻
    knn_matches = bf.knnMatch(desc1, desc2, k=2)

    good_matches = []
    for m, n in knn_matches:
        # Lowe's ratio test: 最近邻距离 << 次近邻距离
        if m.distance < ratio_thresh * n.distance:
            good_matches.append(m)

    return good_matches


# ============================================================
# 3. RANSAC 算法求解单应性矩阵（手写实现）
# ============================================================
def compute_homography_ransac(
    pts1: np.ndarray, pts2: np.ndarray,
    ransac_reproj_threshold: float = 4.0,
    max_iters: int = 2000,
    confidence: float = 0.995
) -> Tuple[Optional[np.ndarray], np.ndarray]:
    """
    【RANSAC 算法】随机采样一致性算法 — 手写实现。

    ────────────────────────────────────────────────────────────
    单应性矩阵 (Homography Matrix) 的数学意义：
        单应性矩阵 H 是一个 3×3 的非奇异矩阵，描述了两个平面之间的
        透视变换关系。对于两张拍摄同一平面（或相机只做旋转运动）的照片，
        它们之间的像素对应关系可以用 H 来表示：

            [x']   [h11  h12  h13] [x]
            [y'] = [h21  h22  h23] [y]
            [1 ]   [h31  h32  h33] [1]

        写成非齐次形式：
            x' = (h11*x + h12*y + h13) / (h31*x + h32*y + h33)
            y' = (h21*x + h22*y + h23) / (h31*x + h32*y + h33)

        每对匹配点提供 2 个方程，至少需要 4 对点才能求解 H（忽略缩放自由度，
        H 有 8 个自由度）。实际中通常使用 DLT（直接线性变换）算法求解超定方程组。

    ────────────────────────────────────────────────────────────
    RANSAC 算法的作用：
        特征匹配结果中不可避免地包含误匹配（Outliers）。RANSAC 通过
        迭代随机采样一小部分匹配对估算模型（这里就是 H），然后用该模型
        去"验证"所有匹配对，将符合模型的点归为内点（Inliers），
        不符合的归为外点。迭代多次后取内点数量最多的那次作为最终结果。

        具体步骤：
        1. 随机选取 4 对匹配点
        2. 用这 4 对点计算单应性矩阵 H
        3. 用 H 将所有 src 点投影到 dst 视角，计算每个点的投影误差
        4. 误差 < threshold 的为内点，统计内点数量
        5. 重复步骤 1-4 共 max_iters 次
        6. 用最大内点集重新拟合 H（可选）
    ────────────────────────────────────────────────────────────

    参数:
        pts1: 第一张图像中的点坐标，shape=(N, 2)
        pts2: 第二张图像中的对应点坐标，shape=(N, 2)
        ransac_reproj_threshold: RANSAC 重投影误差阈值（像素）
        max_iters: 最大迭代次数
        confidence: 置信度，用于动态计算所需迭代次数

    返回:
        best_H: 最优单应性矩阵 (3×3) 或 None（失败时）
        best_inlier_mask: 内点掩码，布尔数组 shape=(N,)
    """
    N = pts1.shape[0]
    if N < 4:
        print("[警告] 匹配点不足 4 对，无法计算单应性矩阵！")
        return None, np.zeros(N, dtype=bool)

    best_H = None
    best_inlier_count = 0
    best_inlier_mask = np.zeros(N, dtype=bool)

    # 自适应迭代次数：如果提前找到足够好的模型可以提前终止
    required_inliers = int(N * 0.5)  # 期望至少 50% 为内点

    # 当前实际迭代次数
    iters = 0

    for iters in range(max_iters):
        # ---- 步骤1: 随机采样4对点 ----
        rand_idx = np.random.choice(N, 4, replace=False)
        sample_pts1 = pts1[rand_idx]
        sample_pts2 = pts2[rand_idx]

        # ---- 步骤2: 用 4 对点计算单应性矩阵 ----
        # 使用 OpenCV 的 findHomography 的 DLT 模式 (method=0)
        # 注意：这里我们只用它求解 4 个点的 H，不需要 RANSAC
        H, _ = cv2.findHomography(sample_pts1, sample_pts2, method=0)
        if H is None:
            continue

        # ---- 步骤3: 重投影所有点并计算误差 ----
        # 将 pts1 转为齐次坐标 [x, y, 1]
        ones = np.ones((N, 1))
        pts1_h = np.concatenate([pts1, ones], axis=1)  # (N, 3)

        # 投影到 dst 视角: pts2_pred = H * pts1_h^T
        pts2_pred_h = (H @ pts1_h.T).T  # (N, 3)

        # 归一化齐次坐标
        pts2_pred = pts2_pred_h[:, :2] / (pts2_pred_h[:, 2:3] + 1e-10)

        # 计算欧氏距离误差
        errors = np.linalg.norm(pts2_pred - pts2, axis=1)

        # ---- 步骤4: 统计内点 ----
        inlier_mask = errors < ransac_reproj_threshold
        inlier_count = np.sum(inlier_mask)

        # ---- 步骤5: 更新最优结果 ----
        if inlier_count > best_inlier_count:
            best_inlier_count = inlier_count
            best_inlier_mask = inlier_mask.copy()
            best_H = H

            # 如果内点已超过预期，并且置信度足够，提前终止
            if inlier_count >= required_inliers:
                # 用当前内点重新估算一次 H
                best_H, _ = cv2.findHomography(
                    pts1[best_inlier_mask], pts2[best_inlier_mask], method=0
                )
                break

    # 用最终内点集重新拟合 H 以获得更精确的结果
    if best_H is not None and np.sum(best_inlier_mask) >= 4:
        best_H, _ = cv2.findHomography(
            pts1[best_inlier_mask], pts2[best_inlier_mask], method=0
        )

    return best_H, best_inlier_mask


# ============================================================
# 4. 动态计算拼接画布边界
# ============================================================
def compute_canvas_size(
    img1: np.ndarray, img2: np.ndarray, H: np.ndarray
) -> Tuple[int, int, np.ndarray]:
    """
    计算拼接后画布的大小，并生成一个偏移变换矩阵，
    以确保两张图都能完整显示在画布内，不发生裁切。

    思路：
        将 img1 的四个角点和 img2 的四个角点都变换到拼接后的坐标系中，
        找到所有点的最小/最大 x, y 作为画布边界。
        同时需要构建一个 translate 矩阵，将坐标平移到非负区域。

    参数:
        img1: 基准图像（参考帧）
        img2: 待变换图像
        H: 将 img2 变换到 img1 视角的单应性矩阵

    返回:
        canvas_width, canvas_height: 画布的宽高
        translate_H: 平移变换矩阵，使得所有坐标 >= 0
    """
    h1, w1 = img1.shape[:2]
    h2, w2 = img2.shape[:2]

    # img1 的四个角
    corners1 = np.array([
        [0, 0],
        [w1 - 1, 0],
        [w1 - 1, h1 - 1],
        [0, h1 - 1]
    ], dtype=np.float32)

    # img2 的四个角，变换到 img1 视角
    corners2 = np.array([
        [0, 0],
        [w2 - 1, 0],
        [w2 - 1, h2 - 1],
        [0, h2 - 1]
    ], dtype=np.float32)

    # 用 H 变换 img2 的角点
    corners2_transformed = cv2.perspectiveTransform(
        corners2.reshape(-1, 1, 2), H
    ).reshape(-1, 2)

    # 合并所有角点
    all_corners = np.vstack([corners1, corners2_transformed])

    # 找到边界
    x_min = np.floor(np.min(all_corners[:, 0])).astype(int)
    x_max = np.ceil(np.max(all_corners[:, 0])).astype(int)
    y_min = np.floor(np.min(all_corners[:, 1])).astype(int)
    y_max = np.ceil(np.max(all_corners[:, 1])).astype(int)

    canvas_width = x_max - x_min
    canvas_height = y_max - y_min

    # 如果边界为负，添加平移
    tx = -x_min
    ty = -y_min

    # 平移变换矩阵
    translate_H = np.array([
        [1, 0, tx],
        [0, 1, ty],
        [0, 0, 1]
    ], dtype=np.float64)

    return canvas_width, canvas_height, translate_H


# ============================================================
# 5. 加权融合（Weighted Blending）消除接缝
# ============================================================
def weighted_blend(
    img1_warped: np.ndarray,
    img2_warped: np.ndarray,
    alpha: float = 0.5
) -> np.ndarray:
    """
    【加权融合算法】消除两张图重叠区域的"接缝"。

    ────────────────────────────────────────────────────────────
    原理说明：
        直接将两张透视变换后的图叠加会产生明显的拼接痕迹，
        这是因为两张图在重叠区域的亮度、色度存在差异。

        加权融合的核心思想是：
        - 在重叠区域，每个像素的值由两张图的对应像素按权重混合得到。
        - 权重的设计原则通常是"越靠近当前图的中心，该图的贡献越大"。
        - 最简单的方式是取平均值（alpha=0.5），但更平滑的方式是
          使用距离加权或线性渐变。

        本函数实现的是"距离加权融合"：
        - 对每张图的每个像素，计算其到最近图像边界的距离。
        - 用该距离作为权重值，距离边界越远的像素权重越大，
          这样在重叠区域可以平滑过渡。

        具体而言，利用 OpenCV 的 distanceTransform 计算每个像素
        到最近零像素的距离，作为该像素的权重。归一化后在重叠区域
        按权重比例混合两张图。

        对于非重叠区域，直接取各自的原像素值。
    ────────────────────────────────────────────────────────────

    参数:
        img1_warped: 第一张图（基准图，已在画布上）
        img2_warped: 第二张图（已变换至画布上）
        alpha: 混合比例（仅当无距离图时作为 fallback）

    返回:
        blended: 融合后的图像
    """
    # 创建两张图的掩码（哪些区域有像素）
    mask1 = np.all(img1_warped > 0, axis=2).astype(np.uint8) * 255
    mask2 = np.all(img2_warped > 0, axis=2).astype(np.uint8) * 255

    # 重叠区域
    overlap_mask = cv2.bitwise_and(mask1, mask2)

    # 如果没有重叠区域，直接平均叠加
    if np.sum(overlap_mask > 0) < 100:
        result = np.where(img2_warped > 0, img2_warped, img1_warped)
        return result

    # ---- 计算距离权重 ----
    # 对每张图计算到边界的距离，用于生成平滑权重

    # 创建距离图：距离越远，权重越大
    dist1 = cv2.distanceTransform(mask1, cv2.DIST_L2, 5)
    dist2 = cv2.distanceTransform(mask2, cv2.DIST_L2, 5)

    # 归一化到 [0, 1]
    if np.max(dist1) > 0:
        dist1 = dist1 / np.max(dist1)
    if np.max(dist2) > 0:
        dist2 = dist2 / np.max(dist2)

    # ---- 加权融合 ----
    # 在重叠区域: weighted = (w1 * img1 + w2 * img2) / (w1 + w2)
    # 权重的分子
    weight1 = dist1
    weight2 = dist2

    # 对每个通道应用加权混合
    result = np.zeros_like(img1_warped, dtype=np.float32)

    for c in range(3):
        numerator = (weight1 * img1_warped[:, :, c].astype(np.float32) +
                     weight2 * img2_warped[:, :, c].astype(np.float32))
        denominator = weight1 + weight2 + 1e-10  # 避免除零

        # 只在重叠区域使用加权混合
        result[:, :, c] = np.where(
            overlap_mask > 0,
            numerator / denominator,
            img1_warped[:, :, c].astype(np.float32) +
            img2_warped[:, :, c].astype(np.float32)
        )

    # 确保非重叠区域正确
    result = np.where(
        np.stack([overlap_mask] * 3, axis=2) > 0,
        result,
        np.where(img2_warped > 0, img2_warped, img1_warped)
    )

    return np.clip(result, 0, 255).astype(np.uint8)


# ============================================================
# 6. 主拼接流程
# ============================================================
def stitch_images(img_left: np.ndarray, img_right: np.ndarray) -> np.ndarray:
    """
    完整图像拼接流程：
        特征提取 → 特征匹配 → RANSAC 估计 H → 透视变换 → 加权融合

    参数:
        img_left: 左图（基准图）
        img_right: 右图（待变换到左图视角）

    返回:
        panorama: 全景拼接结果
    """
    # ---- 步骤1: 特征提取 ----
    print("=" * 55)
    print("  图像全景拼接器 (Image Panorama Stitcher)")
    print("=" * 55)

    print("\n[1/5] 正在提取 SIFT 特征...")
    kp_left, desc_left = detect_and_compute(img_left)
    kp_right, desc_right = detect_and_compute(img_right)
    print(f"      左图: {len(kp_left)} 个关键点")
    print(f"      右图: {len(kp_right)} 个关键点")

    # ---- 步骤2: 特征匹配 ----
    print("\n[2/5] 正在匹配特征点 (BFMatcher + Lowe's ratio test)...")
    matches = match_features(desc_left, desc_right)
    print(f"      匹配对: {len(matches)} 对")

    if len(matches) < 4:
        raise RuntimeError(
            f"匹配点不足 ({len(matches)} < 4)，无法计算单应性矩阵。"
        )

    # 提取匹配点坐标
    pts_left = np.float32([kp_left[m.queryIdx].pt for m in matches])
    pts_right = np.float32([kp_right[m.trainIdx].pt for m in matches])

    # ---- 步骤3: RANSAC 求解单应性矩阵 ----
    print("\n[3/5] RANSAC 鲁棒估计单应性矩阵...")
    H, inlier_mask = compute_homography_ransac(pts_left, pts_right)

    if H is None:
        raise RuntimeError("RANSAC 未能计算出有效的单应性矩阵！")

    n_inliers = np.sum(inlier_mask)
    n_total = len(matches)
    inlier_ratio = n_inliers / n_total * 100
    print(f"      总匹配点: {n_total}")
    print(f"      RANSAC 内点: {n_inliers} ({inlier_ratio:.1f}%)")
    print(f"      外点(误匹配): {n_total - n_inliers}")

    # 打印单应性矩阵
    print(f"\n      估算的单应性矩阵 H (3×3):")
    for row in H:
        print(f"        [{row[0]:.6f}, {row[1]:.6f}, {row[2]:.6f}]")

    # ---- 步骤4: 动态计算画布 ----
    print("\n[4/5] 计算拼接画布边界...")
    canvas_w, canvas_h, translate_H = compute_canvas_size(
        img_left, img_right, H
    )
    print(f"      画布尺寸: {canvas_w} × {canvas_h}")

    # ---- 步骤5: 透视变换与融合 ----
    print("\n[5/5] 透视变换 + 加权融合...")

    # 组合变换矩阵: 先透视变换再平移
    # 注意：我们的 H 是将右图变换到左图视角
    # 对于左图（基准图），我们应用纯平移将其放到画布上
    # 对于右图，应用 translate_H @ H

    # 变换左图（只需平移到画布上）
    warp_H_left = translate_H.copy()  # 纯平移

    # 变换右图（先透视变换到左图视角，再平移）
    warp_H_right = translate_H @ H

    # 执行透视变换
    img_left_warped = cv2.warpPerspective(
        img_left, warp_H_left, (canvas_w, canvas_h),
        flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0
    )

    img_right_warped = cv2.warpPerspective(
        img_right, warp_H_right, (canvas_w, canvas_h),
        flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0
    )

    # 加权融合消除接缝
    print("      正在进行加权融合消除接缝...")
    panorama = weighted_blend(img_left_warped, img_right_warped)

    print("\n" + "=" * 55)
    print("  ✅ 全景拼接完成！")
    print("=" * 55)

    return panorama


# ============================================================
# 7. 可视化与主入口
# ============================================================
def show_result(panorama: np.ndarray) -> None:
    """用 matplotlib 显示拼接结果。"""
    # BGR -> RGB
    panorama_rgb = cv2.cvtColor(panorama, cv2.COLOR_BGR2RGB)

    plt.figure("全景拼接结果 (Image Stitching Result)", figsize=(16, 8))
    plt.imshow(panorama_rgb)
    plt.axis("off")
    plt.tight_layout()
    plt.show()


def show_matches_visualization(
    img_left: np.ndarray, kp_left: List[cv2.KeyPoint],
    img_right: np.ndarray, kp_right: List[cv2.KeyPoint],
    matches: List[cv2.DMatch],
    inlier_mask: np.ndarray
) -> None:
    """显示匹配点连线图（绿色=内点，红色=外点）。"""
    # 筛选内外点
    inlier_matches = [m for m, is_in in zip(matches, inlier_mask) if is_in]
    outlier_matches = [m for m, is_in in zip(matches, inlier_mask) if not is_in]

    # 绘制
    img_matches = cv2.drawMatches(
        img_left, kp_left, img_right, kp_right,
        inlier_matches, None,
        matchColor=(0, 255, 0),   # 内点绿色
        singlePointColor=None,
        flags=cv2.DrawMatchesFlags_NOT_DRAW_SINGLE_POINTS
    )

    # 额外绘制外点（红色）
    if outlier_matches:
        img_matches = cv2.drawMatches(
            img_left, kp_left, img_right, kp_right,
            outlier_matches, img_matches,
            matchColor=(0, 0, 255),  # 外点红色
            singlePointColor=None,
            flags=cv2.DrawMatchesFlags_DRAW_OVER_OUTIMG
        )

    plt.figure("特征匹配结果 (绿色=内点, 红色=外点)", figsize=(18, 9))
    plt.imshow(cv2.cvtColor(img_matches, cv2.COLOR_BGR2RGB))
    plt.axis("off")
    plt.tight_layout()
    plt.show()


def main():
    """
    主函数：读取两张本地图片，执行全景拼接。
    ==================================================
    使用说明：
        1. 将两张有重叠区域的图片放在本地。
        2. 修改下方 img_left_path 和 img_right_path 为实际路径。
        3. 在终端执行: python image_stitcher.py
    ==================================================
    """

    # ==============================================
    # <<< 请修改为你的本地图片路径 >>>
    # ==============================================
    img_left_path = "../img_left.jpg"
    img_right_path = "../img_right.jpg"

    # ---- 读取图片 ----
    try:
        print(f"正在读取左图: {img_left_path}")
        img_left = cv2.imread(img_left_path)
        if img_left is None:
            raise FileNotFoundError(f"无法读取文件: {img_left_path}")

        print(f"正在读取右图: {img_right_path}")
        img_right = cv2.imread(img_right_path)
        if img_right is None:
            raise FileNotFoundError(f"无法读取文件: {img_right_path}")

        print(f"  左图尺寸: {img_left.shape[1]}×{img_left.shape[0]}")
        print(f"  右图尺寸: {img_right.shape[1]}×{img_right.shape[0]}")

    except FileNotFoundError as e:
        print(f"\n❌ 文件读取失败: {e}")
        print("请检查图片路径是否正确，以及文件是否存在。")
        print("可尝试使用绝对路径，或将图片放在与脚本相同的目录下。")
        return
    except Exception as e:
        print(f"\n❌ 读取图片时发生未知错误: {e}")
        return

    # ---- 执行拼接 ----
    try:
        panorama = stitch_images(img_left, img_right)
    except Exception as e:
        print(f"\n❌ 拼接过程失败: {e}")
        return

    # ---- 显示结果 ----
    print("\n正在显示拼接结果窗口，关闭窗口后程序退出...")
    show_result(panorama)

    # 可选：保存结果到本地
    # cv2.imwrite("panorama_result.jpg", panorama)
    # print("结果已保存到 panorama_result.jpg")


if __name__ == "__main__":
    main()
