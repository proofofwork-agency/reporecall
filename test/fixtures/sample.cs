using System;
using System.Collections.Generic;

interface IRepository<T> {
    T GetById(int id);
    void Save(T entity);
    void Delete(int id);
}

enum Priority {
    Low,
    Medium,
    High,
    Critical
}

struct Timestamp {
    public long Ticks;
    public string Zone;

    public DateTime ToDateTime() {
        return new DateTime(Ticks);
    }
}

class TaskItem {
    public int Id { get; set; }
    public string Title { get; set; }
    public Priority Priority { get; set; }

    public TaskItem(int id, string title, Priority priority) {
        Id = id;
        Title = title;
        Priority = priority;
    }

    public bool IsHighPriority() {
        return Priority >= Priority.High;
    }

    public override string ToString() {
        return $"[{Priority}] {Title}";
    }
}
