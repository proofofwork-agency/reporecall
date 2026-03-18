-- Vector math library

function vec_add(a, b)
    return { x = a.x + b.x, y = a.y + b.y }
end

function vec_scale(v, scalar)
    return { x = v.x * scalar, y = v.y * scalar }
end

local function vec_length(v)
    return math.sqrt(v.x * v.x + v.y * v.y)
end

local normalize = function(v)
    local len = vec_length(v)
    if len == 0 then return { x = 0, y = 0 } end
    return vec_scale(v, 1 / len)
end

local Matrix = {}
Matrix.__index = Matrix

function Matrix.new(rows, cols)
    local self = setmetatable({}, Matrix)
    self.rows = rows
    self.cols = cols
    self.data = {}
    return self
end

function Matrix:get(r, c)
    return self.data[r * self.cols + c]
end
