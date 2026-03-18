const std = @import("std");

/// A 2D vector for math operations.
const Vec2 = struct {
    x: f32,
    y: f32,

    pub fn add(self: Vec2, other: Vec2) Vec2 {
        return Vec2{ .x = self.x + other.x, .y = self.y + other.y };
    }

    pub fn length(self: Vec2) f32 {
        return @sqrt(self.x * self.x + self.y * self.y);
    }
};

fn fibonacci(n: u32) u32 {
    if (n <= 1) return n;
    return fibonacci(n - 1) + fibonacci(n - 2);
}

test "fibonacci returns correct values" {
    try std.testing.expectEqual(fibonacci(0), 0);
    try std.testing.expectEqual(fibonacci(5), 5);
    try std.testing.expectEqual(fibonacci(10), 55);
}
