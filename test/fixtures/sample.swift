import Foundation

protocol Describable {
    var description: String { get }
    func describe() -> String
}

enum Season {
    case spring, summer, autumn, winter

    var emoji: String {
        switch self {
        case .spring: return "🌱"
        case .summer: return "☀️"
        case .autumn: return "🍂"
        case .winter: return "❄️"
        }
    }
}

struct Temperature {
    let celsius: Double

    var fahrenheit: Double {
        return celsius * 9.0 / 5.0 + 32.0
    }
}

class WeatherStation: Describable {
    let name: String
    var readings: [Temperature] = []

    init(name: String) {
        self.name = name
    }

    func record(temp: Temperature) {
        readings.append(temp)
    }

    func average() -> Double {
        guard !readings.isEmpty else { return 0 }
        return readings.map { $0.celsius }.reduce(0, +) / Double(readings.count)
    }

    var description: String {
        return "\(name): \(readings.count) readings"
    }

    func describe() -> String {
        return description
    }
}

func createStation(named name: String) -> WeatherStation {
    return WeatherStation(name: name)
}
