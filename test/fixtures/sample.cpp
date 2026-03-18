#include <string>
#include <vector>
#include <iostream>

namespace geometry {

enum class Color {
    Red,
    Green,
    Blue
};

struct Vec2 {
    double x;
    double y;

    double length() const {
        return std::sqrt(x * x + y * y);
    }
};

class Canvas {
public:
    Canvas(int width, int height)
        : width_(width), height_(height) {}

    void drawLine(Vec2 from, Vec2 to) {
        std::cout << "Drawing line" << std::endl;
    }

    int getWidth() const { return width_; }
    int getHeight() const { return height_; }

private:
    int width_;
    int height_;
    std::vector<Vec2> points_;
};

} // namespace geometry

void renderScene(geometry::Canvas& canvas) {
    canvas.drawLine({0, 0}, {1, 1});
}
