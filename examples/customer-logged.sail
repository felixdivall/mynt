beforeSubmit create (customer: Customer) {
    log.audit("Customer create")
    customer.comments = "Managed by Sail"
}
