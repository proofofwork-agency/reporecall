/// A point in 2D space.
struct Point {
    x: f64,
    y: f64,
}

enum Shape {
    Circle(f64),
    Rectangle(f64, f64),
}

trait Drawable {
    fn draw(&self);
    fn area(&self) -> f64;
}

impl Drawable for Shape {
    fn draw(&self) {
        match self {
            Shape::Circle(r) => println!("Drawing circle with radius {}", r),
            Shape::Rectangle(w, h) => println!("Drawing rect {}x{}", w, h),
        }
    }

    fn area(&self) -> f64 {
        match self {
            Shape::Circle(r) => std::f64::consts::PI * r * r,
            Shape::Rectangle(w, h) => w * h,
        }
    }
}

fn distance(a: &Point, b: &Point) -> f64 {
    ((b.x - a.x).powi(2) + (b.y - a.y).powi(2)).sqrt()
}
