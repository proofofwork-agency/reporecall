#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* A node in a linked list */
struct Node {
    int value;
    struct Node* next;
};

enum Status {
    STATUS_OK = 0,
    STATUS_ERROR = 1,
    STATUS_NOT_FOUND = 2
};

typedef struct {
    struct Node* head;
    int length;
} LinkedList;

struct Node* create_node(int value) {
    struct Node* node = malloc(sizeof(struct Node));
    node->value = value;
    node->next = NULL;
    return node;
}

void list_append(LinkedList* list, int value) {
    struct Node* node = create_node(value);
    if (list->head == NULL) {
        list->head = node;
    } else {
        struct Node* curr = list->head;
        while (curr->next != NULL) {
            curr = curr->next;
        }
        curr->next = node;
    }
    list->length++;
}

void list_free(LinkedList* list) {
    struct Node* curr = list->head;
    while (curr != NULL) {
        struct Node* next = curr->next;
        free(curr);
        curr = next;
    }
    list->head = NULL;
    list->length = 0;
}
