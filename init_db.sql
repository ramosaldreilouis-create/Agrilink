CREATE DATABASE IF NOT EXISTS agrilink_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE agrilink_db;

-- Platform users
CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    full_name VARCHAR(100) NOT NULL,
    email VARCHAR(120) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    location VARCHAR(255) NULL,
    suki_points INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_email (email)
) ENGINE=InnoDB;

-- Community hubs for pickup coordination
CREATE TABLE IF NOT EXISTS community_hubs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    hub_name VARCHAR(100) NOT NULL,
    location_address TEXT NOT NULL,
    hub_leader_id INT NOT NULL,
    next_delivery_date DATETIME,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (hub_leader_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_hub_leader (hub_leader_id)
) ENGINE=InnoDB;

-- Products with bilingual search support
CREATE TABLE IF NOT EXISTS products (
    id INT AUTO_INCREMENT PRIMARY KEY,
    farmer_id INT NOT NULL,
    name_en VARCHAR(100) NOT NULL,
    name_tl VARCHAR(100) NOT NULL,
    category ENUM('vegetables', 'rice', 'fruits', 'poultry') NOT NULL,
    price_per_kg DECIMAL(10,2) NOT NULL,
    farm_gate_price DECIMAL(10,2) NOT NULL,
    logistics_fee DECIMAL(10,2) NOT NULL DEFAULT 0,
    platform_fee DECIMAL(10,2) NOT NULL DEFAULT 0,
    expected_yield_kg INT DEFAULT 0,
    harvest_date DATE NOT NULL,
    status ENUM('available', 'preorder', 'sold_out') DEFAULT 'available',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (farmer_id) REFERENCES users(id) ON DELETE CASCADE,
    FULLTEXT INDEX idx_products_search (name_en, name_tl),
    INDEX idx_category (category),
    INDEX idx_farmer (farmer_id),
    INDEX idx_status (status)
) ENGINE=InnoDB;

-- Discount vouchers
CREATE TABLE IF NOT EXISTS vouchers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(20) UNIQUE NOT NULL,
    discount_percentage INT NOT NULL,
    max_discount_amount DECIMAL(10,2) NOT NULL,
    min_order_amount DECIMAL(10,2) DEFAULT 0,
    is_active TINYINT(1) DEFAULT 1,
    expires_at DATETIME,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_code (code),
    INDEX idx_active (is_active)
) ENGINE=InnoDB;

-- Community orders
CREATE TABLE IF NOT EXISTS orders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    buyer_id INT NOT NULL,
    hub_id INT NOT NULL,
    total_amount DECIMAL(10,2) NOT NULL,
    voucher_id INT NULL,
    suki_points_used INT DEFAULT 0,
    payment_method ENUM('gcash', 'cod', 'card') DEFAULT 'gcash',
    status ENUM('confirmed', 'preparing', 'collection', 'completed') DEFAULT 'confirmed',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (buyer_id) REFERENCES users(id),
    FOREIGN KEY (hub_id) REFERENCES community_hubs(id),
    FOREIGN KEY (voucher_id) REFERENCES vouchers(id),
    INDEX idx_buyer (buyer_id),
    INDEX idx_hub (hub_id),
    INDEX idx_status (status),
    INDEX idx_created (created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS order_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    order_id INT NOT NULL,
    product_id INT NOT NULL,
    quantity_kg DECIMAL(10,2) NOT NULL,
    price_per_kg DECIMAL(10,2) NOT NULL,
    subtotal DECIMAL(10,2) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id),
    INDEX idx_order (order_id),
    INDEX idx_product (product_id)
) ENGINE=InnoDB;

-- Seed data
INSERT INTO users (full_name, email, password_hash, suki_points) VALUES
('Juan Dela Cruz', 'juan@agrilink.ph', '$2y$10$e0MYzXyjpJS7Pd0RVvHwHe1xqA7Ym0P4a', 100),
('Maria Clara', 'maria@agrilink.ph', '$2y$10$e0MYzXyjpJS7Pd0RVvHwHe1xqA7Ym0P4a', 250),
('Admin User', 'admin@agrilink.ph', '$2y$10$e0MYzXyjpJS7Pd0RVvHwHe1xqA7Ym0P4a', 0)
ON DUPLICATE KEY UPDATE id = id;

INSERT INTO community_hubs (hub_name, location_address, hub_leader_id, next_delivery_date)
SELECT seed.hub_name, seed.location_address, seed.hub_leader_id, seed.next_delivery_date
FROM (
    SELECT 'Northview Community Hub' AS hub_name, '123 Northview Street, Barangay Northview, Quezon City' AS location_address, (SELECT id FROM users WHERE email = 'maria@agrilink.ph' LIMIT 1) AS hub_leader_id, DATE_ADD(CURDATE(), INTERVAL 1 DAY) + INTERVAL 10 HOUR AS next_delivery_date
    UNION ALL
    SELECT 'Greenfield HOA Hub', '456 Greenfield Avenue, Barangay Greenfield, Makati City', (SELECT id FROM users WHERE email = 'maria@agrilink.ph' LIMIT 1), DATE_ADD(CURDATE(), INTERVAL 2 DAY) + INTERVAL 9 HOUR
) AS seed
WHERE NOT EXISTS (
    SELECT 1 FROM community_hubs existing WHERE existing.hub_name = seed.hub_name
);

UPDATE community_hubs
SET next_delivery_date = CASE hub_name
    WHEN 'Northview Community Hub' THEN DATE_ADD(CURDATE(), INTERVAL 1 DAY) + INTERVAL 10 HOUR
    WHEN 'Greenfield HOA Hub' THEN DATE_ADD(CURDATE(), INTERVAL 2 DAY) + INTERVAL 9 HOUR
END
WHERE hub_name IN ('Northview Community Hub', 'Greenfield HOA Hub');

INSERT INTO products (farmer_id, name_en, name_tl, category, price_per_kg, farm_gate_price, logistics_fee, platform_fee, expected_yield_kg, harvest_date)
SELECT seed.farmer_id, seed.name_en, seed.name_tl, seed.category, seed.price_per_kg, seed.farm_gate_price, seed.logistics_fee, seed.platform_fee, seed.expected_yield_kg, seed.harvest_date
FROM (
    SELECT (SELECT id FROM users WHERE email = 'juan@agrilink.ph' LIMIT 1) AS farmer_id, 'Fresh Tomatoes' AS name_en, 'Kamatis' AS name_tl, 'vegetables' AS category, 65.00 AS price_per_kg, 55.00 AS farm_gate_price, 7.00 AS logistics_fee, 3.00 AS platform_fee, 120 AS expected_yield_kg, DATE_ADD(CURDATE(), INTERVAL 1 DAY) AS harvest_date
    UNION ALL
    SELECT (SELECT id FROM users WHERE email = 'juan@agrilink.ph' LIMIT 1), 'Carrots', 'Karots', 'vegetables', 70.00, 58.00, 8.00, 4.00, 80, DATE_ADD(CURDATE(), INTERVAL 2 DAY)
    UNION ALL
    SELECT (SELECT id FROM users WHERE email = 'juan@agrilink.ph' LIMIT 1), 'Bananas', 'Saging', 'fruits', 55.00, 45.00, 6.00, 4.00, 140, DATE_ADD(CURDATE(), INTERVAL 3 DAY)
    UNION ALL
    SELECT (SELECT id FROM users WHERE email = 'juan@agrilink.ph' LIMIT 1), 'Brown Rice', 'Bigas', 'rice', 58.00, 50.00, 5.00, 3.00, 500, DATE_ADD(CURDATE(), INTERVAL 6 DAY)
) AS seed
WHERE NOT EXISTS (
    SELECT 1
    FROM products existing
    WHERE existing.farmer_id = seed.farmer_id
      AND existing.name_en = seed.name_en
      AND existing.name_tl = seed.name_tl
);

UPDATE products existing
JOIN users farmer ON farmer.id = existing.farmer_id
SET existing.harvest_date = CASE existing.name_en
    WHEN 'Fresh Tomatoes' THEN DATE_ADD(CURDATE(), INTERVAL 1 DAY)
    WHEN 'Carrots' THEN DATE_ADD(CURDATE(), INTERVAL 2 DAY)
    WHEN 'Bananas' THEN DATE_ADD(CURDATE(), INTERVAL 3 DAY)
    WHEN 'Brown Rice' THEN DATE_ADD(CURDATE(), INTERVAL 6 DAY)
END
WHERE farmer.email = 'juan@agrilink.ph'
  AND (
      (existing.name_en = 'Fresh Tomatoes' AND existing.name_tl = 'Kamatis')
      OR (existing.name_en = 'Carrots' AND existing.name_tl = 'Karots')
      OR (existing.name_en = 'Bananas' AND existing.name_tl = 'Saging')
      OR (existing.name_en = 'Brown Rice' AND existing.name_tl = 'Bigas')
  );

INSERT INTO vouchers (code, discount_percentage, max_discount_amount, min_order_amount, expires_at) VALUES
('SUKI10', 10, 50.00, 200.00, DATE_ADD(NOW(), INTERVAL 90 DAY)),
('AGRI20', 20, 100.00, 500.00, DATE_ADD(NOW(), INTERVAL 90 DAY)),
('BAGONGANI', 15, 75.00, 300.00, DATE_ADD(NOW(), INTERVAL 60 DAY))
ON DUPLICATE KEY UPDATE discount_percentage = VALUES(discount_percentage), max_discount_amount = VALUES(max_discount_amount), min_order_amount = VALUES(min_order_amount), expires_at = VALUES(expires_at), is_active = VALUES(is_active);
